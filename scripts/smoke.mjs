// Opt-in live smoke test. API key is read locally, never printed or put in argv.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { importMagpieKey, configDirectory } from "../src/paths.mjs";
import { createBridge, MIB } from "../src/bridge.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i=0; i<8; i++) crc = (crc>>>1) ^ ((crc&1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const tag=Buffer.from(type), out=Buffer.alloc(bytes.length+12);
  out.writeUInt32BE(bytes.length); tag.copy(out,4); bytes.copy(out,8); out.writeUInt32BE(crc32(Buffer.concat([tag,bytes])),8+bytes.length);
  return out;
}
function diagnosticPNG() {
  const width=96, height=64, header=Buffer.alloc(13), rows=Buffer.alloc(height*(1+width*3));
  header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const off=y*(1+width*3)+1+x*3; rows[off]=x<width/2?255:0; rows[off+2]=x<width/2?0:255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
}
const key = await importMagpieKey();
const metrics = [];
const bridge = createBridge({ getAuth: async()=>({type:"api",key}), cacheDir: join(configDirectory(),"deepseek-files-cache"),
  onMetric: metric=>{ metrics.push(metric); console.log(JSON.stringify(metric)); } });
const image = bytes=>({type:"input_image",image_url:`data:image/png;base64,${bytes.toString("base64")}`});
const call = async body=>{
  const response = await bridge("https://api.deepseek.com/v1/responses", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
  const text = await response.text();
  let result;try{result=JSON.parse(text);}catch{throw new Error(`DeepSeek returned non-JSON, HTTP ${response.status}`);}
  if(!response.ok)throw new Error(`DeepSeek returned HTTP ${response.status}: ${result.error?.message??"unknown"}`);
  const answer=(result.output??[]).flatMap(x=>x.content??[]).filter(x=>x.type==="output_text").map(x=>x.text).join("");
  console.log(JSON.stringify({event:"inference",status:response.status,answer,usage:result.usage}));
  return {status:response.status,answer,usage:result.usage};
};
const out={time:new Date().toISOString(),tests:[]};
const png=diagnosticPNG();
const vision={model:"deepseek-flash",reasoning:{effort:"none"},max_output_tokens:128,input:[{role:"user",content:[{type:"input_text",text:'Return only JSON: {"left":"color","right":"color"}. What colors are the LEFT and RIGHT halves of this image?'},image(png)]}]};
const visual=await call(vision);
const parsed=JSON.parse(visual.answer);
if(parsed.left?.toLowerCase()!=="red"||parsed.right?.toLowerCase()!=="blue")throw new Error("Uploaded file was not correctly understood visually");
out.tests.push({name:"file_reference_visual_understanding",...visual});
await call(vision); // Verify persistent cache reuse.
const rolloutIndex=process.argv.indexOf("--rollout");
if(rolloutIndex>=0){
  const images=[];
  const walk=value=>{
    if(Array.isArray(value)){for(const x of value)walk(x);}
    else if(value&&typeof value==="object"){
      if(value.type==="input_image"&&typeof value.image_url==="string"&&value.image_url.startsWith("data:image/"))images.push(structuredClone(value));
      else for(const x of Object.values(value))if(x&&typeof x==="object")walk(x);
    }
  };
  for(const line of (await readFile(process.argv[rolloutIndex+1],"utf8")).split(/\r?\n/))if(line){const row=JSON.parse(line);if(row.type==="response_item")walk(row.payload);}
  if(!images.length)throw new Error("No inline images in rollout");
  const originalImages=images.length;
  const replay={model:"deepseek-flash",reasoning:{effort:"none"},max_output_tokens:48,input:[{role:"user",content:[{type:"input_text",text:"This is a transport regression test. Reply only OK_FILE_BRIDGE."},...images]}]};
  while(Buffer.byteLength(JSON.stringify(replay))<=49*MIB)replay.input[0].content.push(structuredClone(images[0]));
  const beforeBytes=Buffer.byteLength(JSON.stringify(replay));
  console.log(JSON.stringify({event:"replay_start",originalImages,submittedImages:replay.input[0].content.length-1,beforeBytes}));
  const result=await call(replay);
  if(!result.answer.includes("OK_FILE_BRIDGE"))throw new Error("Regression test did not return the expected marker");
  out.tests.push({name:"over_48_mib_real_history",originalImages,submittedImages:replay.input[0].content.length-1,beforeBytes,...result});
  await call(replay);
}
out.metrics=metrics;
await mkdir("validation",{recursive:true});
await writeFile("validation/live-smoke.json",JSON.stringify(out,null,2)+"\n");
console.log("PASS: live smoke, cache reuse, and file-based vision");
