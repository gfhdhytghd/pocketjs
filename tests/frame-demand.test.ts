import {test,expect} from 'bun:test';
import {createRoot} from 'solid-js';
import {onFrame,onButtonPress,resetFrameHooks,runFrameHooks,pocketNeedsFrame} from '../framework/src/frame';
import {after,resetClock,__advanceClock} from '../framework/src/clock';
// Read this module instance; other suites may load another copy that rebinds the global hook.
const needs=pocketNeedsFrame;
test('static observers sleep, events still run them, and an animation retains frames until completion',()=>{
 resetFrameHooks();resetClock();let calls=0,animate=false;let dispose!:()=>void;
 createRoot(d=>{dispose=d;onFrame(()=>{calls++;},()=>false);onFrame(()=>{if(animate&&calls>=3)animate=false;},()=>animate);onButtonPress(1,()=>{animate=true;});});
 expect(needs()).toBe(false);runFrameHooks(1);expect(animate).toBe(true);expect(needs()).toBe(true);runFrameHooks(0);runFrameHooks(0);expect(animate).toBe(false);expect(needs()).toBe(false);expect(calls).toBe(3);dispose();expect(needs()).toBe(false);
});
test('legacy callbacks and pending virtual deadlines retain their original tick contract',()=>{
 resetFrameHooks();resetClock();let dispose!:()=>void;createRoot(d=>{dispose=d;onFrame(()=>{});});expect(needs()).toBe(true);dispose();expect(needs()).toBe(false);let fired=false;after(1/60,()=>{fired=true;});expect(needs()).toBe(true);__advanceClock();__advanceClock();expect(fired).toBe(true);expect(needs()).toBe(false);
});
