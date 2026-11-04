import {test,expect} from 'bun:test';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
test('production build returns the actual frame handler and ignores injected devtools transport',async()=>{
 const result=await Bun.build({entrypoints:[join(import.meta.dir,'devtools-release.fixture.ts')],target:'browser',format:'iife',minify:true,define:{__POCKET_DEVTOOLS__:'false'}});expect(result.success).toBe(true);let polls=0,sends=0;const realm:any={__pocketDevtoolsTransport:{recv(){polls++;return null;},send(){sends++;}}};runInNewContext(await result.outputs[0].text(),realm);expect(realm.releaseResult).toEqual({same:true,calls:3,api:false});expect(polls).toBe(0);expect(sends).toBe(0);
});
