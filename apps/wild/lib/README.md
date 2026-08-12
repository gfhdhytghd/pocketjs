# apps/wild/lib — vendored playset subset

Copied from the `feat/playset` research branch (playset copy-in convention:
the playset tree is a vendored library, not a package dependency):

- `scene3d/` — the scene3d surface contract (`ops.ts`), the guest-side
  retained client (`client.ts`), `<Viewport3D>`, and the renderless
  reference sim (`sim.ts`, used by tests/wild-sim.test.ts).
- `math/` — the three-compatible math subset (Vector3/Quaternion/Matrix4…).
- `loop.ts` — the fixed-step game loop on the virtual clock.

Files are unmodified from the branch. If `feat/playset` lands on main as a
shared library, this directory should be deleted in favor of that import
path; until then, treat the branch as upstream and re-copy rather than
editing here.
