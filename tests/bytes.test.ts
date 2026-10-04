import {expect,test} from "bun:test";
import {stringToUtf8,utf8ToString,base64ToBytes,bytesToBase64} from "../framework/src/bytes.ts";
test("UTF-8 chunked decoding preserves BMP, supplementary and boundary characters",()=>{
 for(const value of ["","ascii\u0000", "\ufeff中文😀𠮷", "x".repeat(1023)+"😀"+"中文".repeat(270000),"😀".repeat(2048)])expect(utf8ToString(stringToUtf8(value))).toBe(value);
});
test("UTF-8 rejects malformed bytes at and across output chunk boundaries",()=>{
 for(const invalid of [[0x80],[0xc0,0x80],[0xe0,0x80,0x80],[0xed,0xa0,0x80],[0xf4,0x90,0x80,0x80],[0xf8,0x80,0x80,0x80],[0xc2],[0xe4,0xb8],[0xf0,0x9f,0x98],[0xe4,0x41,0x80]])for(const prefix of [0,1023,1024])expect(()=>utf8ToString(new Uint8Array([...new Array(prefix).fill(65),...invalid]))).toThrow("invalid UTF-8");
});

test("native Base64 fast path agrees with fallback for complete byte range and padding",()=>{
 const host=globalThis as {pod?:{decodeBase64?:(input:string)=>Uint8Array|null}};const before=host.pod;
 try{for(const length of [0,1,2,3,255,256,262144]){
  const bytes=Uint8Array.from({length},(_,i)=>i&255),encoded=bytesToBase64(bytes);delete host.pod;const fallback=base64ToBytes(encoded);expect(fallback).toEqual(bytes);
  let called=0;host.pod={decodeBase64:input=>{called++;return new Uint8Array(Buffer.from(input,"base64"));}};expect(base64ToBytes(encoded)).toEqual(fallback);expect(called).toBe(1);
 }host.pod={decodeBase64:()=>null};expect(base64ToBytes("AB==")).toEqual(new Uint8Array([0]));}finally{host.pod=before;}
});
