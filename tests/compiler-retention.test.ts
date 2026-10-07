import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transformFile,jsxPlugin} from '../framework/compiler/jsx-plugin.ts';

test('default compiler prop polling does not retain signal observers',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pocket-retention-'));
 try {
  const source=`import {createRoot,createSignal,createRenderEffect} from 'solid-js';
   let reads=0,props,dispose,childMounts=0;
   const [item,setItem]=createSignal({id:1});
   function Child(){childMounts++;return null;}
   const [enabled,setEnabled]=createSignal(true),[ready,setReady]=createSignal(true);
   const active=()=>{reads++;return enabled();};
   function Capture(value){props=value;return null;}
   createRoot(stop=>{dispose=stop;return <><Capture active={active()&&ready()} label={active()?'on':'off'}/>{item()?<Child/>:null}</>;});
   let observed;
   createRoot(stop=>{const previous=dispose;dispose=()=>{stop();previous();};createRenderEffect(()=>{observed=props.active;});});
   export const drive=()=>{
    const results=[];
    for(let round=0;round<6;round++){
     for(let frame=0;frame<900;frame++){if(!props.active||props.label!=='on')throw Error('lost prop value');}
     const before=reads;setEnabled(false);results.push({reads:reads-before,observed,label:props.label});setEnabled(true);
    }
    setReady(false);const branch=observed;setEnabled(false);setReady(true);const inactive=observed;setEnabled(true);const resumed=observed;
    setItem({id:2});const preserved=childMounts;
    dispose();const before=reads;setEnabled(false);
    return {results,branch,inactive,resumed,preserved,afterDispose:reads-before};
   };`;
  const transformed=await transformFile(join(directory,'fixture.tsx'),source,'solid');
  const entry=join(directory,'entry.js');await Bun.write(entry,transformed.code);
  const built=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',conditions:['browser'],plugins:[jsxPlugin('solid')]});
  expect(built.success).toBe(true);
  const output=join(directory,'built.mjs');await Bun.write(output,await built.outputs[0].text());
  const facts=(await import(output)).drive();
  for(const round of facts.results){expect(round.reads).toBeLessThanOrEqual(2);expect(round.observed).toBe(false);expect(round.label).toBe('off');}
  expect(facts.branch).toBe(false);expect(facts.inactive).toBe(false);expect(facts.resumed).toBe(true);expect(facts.afterDispose).toBe(0);expect(facts.preserved).toBe(1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
