// Opt-in test through an already running local Magpie, not a bypass of its plugin host.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { MIB } from "../src/bridge.mjs";

const images=[];
const walk=value=>{
  if(Array.isArray(value)){for(const x of value)walk(x);}
  else if(value&&typeof value==="object"){
    if(value.type==="input_image"&&typeof value.image_url==="string"&&value.image_url.startsWith("data:image/"))images.push(structuredClone(value));
    else for(const x of Object.values(value))if(x&&typeof x==="object")walk(x);
  }
};
const index=process.argv.indexOf("--rollout");
if(index<0)throw new Error("Pass --rollout <local rollout.jsonl>. Nothing from the rollout will be saved in the repository.");
for(const line of (await readFile(process.argv[index+1],"utf8")).split(/\r?\n/))if(line){const row=JSON.parse(line);if(row.type==="response_item")walk(row.payload);}
if(!images.length)throw new Error("No images found");
const request={model:"deepseek-files/deepseek-flash",reasoning:{effort:"none"},max_output_tokens:48,stream:false,input:[{role:"user",content:[{type:"input_text",text:"Transport test: reply only MAGPIE_FILES_OK."},...images]}]};
while(Buffer.byteLength(JSON.stringify(request))<=49*MIB)request.input[0].content.push(structuredClone(images[0]));
const payload=JSON.stringify(request),start=Date.now();
console.log(JSON.stringify({event:"gateway_start",bytes:Buffer.byteLength(payload),images:request.input[0].content.length-1}));
const response=await fetch("http://127.0.0.1:3425/v1/responses",{method:"POST",headers:{authorization:"Bearer magpie","content-type":"application/json"},body:payload,signal:AbortSignal.timeout(240000)});
const data=await response.json();
const answer=(data.output??[]).flatMap(x=>x.content??[]).filter(x=>x.type==="output_text").map(x=>x.text).join("");
if(!response.ok||!answer.includes("MAGPIE_FILES_OK"))throw new Error(`Gateway failed: HTTP ${response.status}, ${data.error?.message??"missing expected output"}`);
const result={status:response.status,answer,usage:data.usage,beforeBytes:Buffer.byteLength(payload),images:request.input[0].content.length-1,elapsedMs:Date.now()-start};
console.log(JSON.stringify(result));
const streamed=await fetch("http://127.0.0.1:3425/v1/responses",{method:"POST",headers:{authorization:"Bearer magpie","content-type":"application/json"},body:JSON.stringify({model:"deepseek-files/deepseek-flash",input:"Reply only STREAM_FILES_OK",reasoning:{effort:"none"},max_output_tokens:48,stream:true}),signal:AbortSignal.timeout(60000)});
const events=await streamed.text();
if(!streamed.ok||!events.includes("response.completed")||!events.includes("STREAM_FILES_OK"))throw new Error("Streaming through native plugin failed");
result.streaming={status:streamed.status,completed:true};
await mkdir("validation",{recursive:true});
await writeFile("validation/gateway-smoke.json",JSON.stringify(result,null,2)+"\n");
console.log("PASS: native Magpie plugin host, large request, and streaming");
