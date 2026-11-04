import {initDevtools,wrapFrameHandler} from '../framework/src/devtools';
let calls=0;const h=()=>{calls++;};initDevtools({} as any);const wrapped=wrapFrameHandler(h);wrapped(0);wrapped(0);wrapped(0);(globalThis as any).releaseResult={same:wrapped===h,calls,api:!!(globalThis as any).__pocketDevtools};
