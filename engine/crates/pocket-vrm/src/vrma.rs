//! `.vrma` (VRMC_vrm_animation) loading and retargeting onto a VRM model.
//!
//! VRMA rotation tracks are authored on the animation file's raw glTF rig.
//! They are first converted into VRM's normalized humanoid space, then into
//! the target VRM 0.x rig's raw local bone space. Hips translation is scaled
//! by the rest hips-height ratio and re-anchored so the first key sits over
//! the origin in X/Z (mirrors airi's `reAnchorRootPositionTrack`).
//!
//! Heights are measured in *channel units* — parent chains accumulated with
//! rotations but ancestor scales ignored — because glTF translation keys
//! live in the node's parent-local space. That absorbs unit mismatches: the
//! airi `idle_loop.vrma` fixture is authored in centimeters under a
//! 0.01-scale parent node, and the ratio still lands hips keys in the
//! model's meters.

use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Quat};
use pocket3d::anim::{Channel, ChannelPath, Clip, Interpolation, NodeTrs, Skeleton};
use serde_json::Value;

use crate::glb::{self, GltfNodes};

/// A parsed `.vrma` document: glTF animation 0 decoded into pocket3d
/// [`Channel`]s (node = vrma node index) plus the humanoid map and the rest
/// hierarchy needed for hips-height scaling.
pub struct VrmaDoc {
    pub name: String,
    pub duration: f32,
    /// VRM humanoid bone name → vrma node index.
    pub humanoid: Vec<(String, usize)>,
    /// Translation/rotation channels of glTF animation 0.
    pub channels: Vec<Channel>,
    /// Rest hierarchy of the vrma's own nodes.
    pub nodes: GltfNodes,
}

impl VrmaDoc {
    /// Look up a humanoid bone's vrma node index.
    pub fn humanoid_node(&self, bone: &str) -> Option<usize> {
        self.humanoid
            .iter()
            .find(|(name, _)| name == bone)
            .map(|&(_, node)| node)
    }
}

/// Parse a `.vrma` GLB: glTF animation 0 plus `VRMC_vrm_animation`.
/// Sampler interpolation LINEAR/STEP is kept; CUBICSPLINE keeps the middle
/// values and degrades to LINEAR. Sparse accessors are rejected.
pub fn load_vrma_bytes(bytes: &[u8]) -> Result<VrmaDoc> {
    let glb = glb::parse_glb(bytes)?;
    let ext = glb
        .json
        .get("extensions")
        .and_then(|e| e.get("VRMC_vrm_animation"))
        .context("not a .vrma: missing extensions.VRMC_vrm_animation")?;

    // humanoid.humanBones is an object: { boneName: { node } }. serde_json
    // objects iterate in sorted key order, so this Vec is deterministic.
    let mut humanoid = Vec::new();
    if let Some(bones) = ext
        .get("humanoid")
        .and_then(|h| h.get("humanBones"))
        .and_then(Value::as_object)
    {
        for (name, v) in bones {
            if let Some(node) = v.get("node").and_then(Value::as_u64) {
                humanoid.push((name.clone(), node as usize));
            }
        }
    }

    let anim = glb
        .json
        .get("animations")
        .and_then(|a| a.get(0))
        .context(".vrma has no animations")?;
    let name = anim
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("vrma")
        .to_string();
    let samplers = anim
        .get("samplers")
        .and_then(Value::as_array)
        .context("animation has no samplers")?;

    let mut channels = Vec::new();
    let mut duration = 0.0f32;
    for ch in anim
        .get("channels")
        .and_then(Value::as_array)
        .context("animation has no channels")?
    {
        let target = ch.get("target").context("channel has no target")?;
        let Some(node) = target.get("node").and_then(Value::as_u64) else {
            continue; // targets without a node are legal glTF; skip
        };
        let path = match target.get("path").and_then(Value::as_str) {
            Some("translation") => ChannelPath::Translation,
            Some("rotation") => ChannelPath::Rotation,
            // "scale"/"weights" (and unknown paths) are out of scope.
            _ => continue,
        };
        let si = ch
            .get("sampler")
            .and_then(Value::as_u64)
            .context("channel has no sampler")? as usize;
        let sampler = samplers.get(si).context("sampler index out of range")?;
        let input = sampler
            .get("input")
            .and_then(Value::as_u64)
            .context("sampler input")?;
        let output = sampler
            .get("output")
            .and_then(Value::as_u64)
            .context("sampler output")?;
        let interp = sampler
            .get("interpolation")
            .and_then(Value::as_str)
            .unwrap_or("LINEAR");

        let (times, tc) = glb::read_f32_accessor(&glb.json, glb.bin, input as usize)?;
        ensure!(tc == 1, "sampler input must be SCALAR");
        let (mut values, comps) = glb::read_f32_accessor(&glb.json, glb.bin, output as usize)?;
        let expected = match path {
            ChannelPath::Translation => 3,
            ChannelPath::Rotation => 4,
            ChannelPath::Scale => unreachable!(),
        };
        ensure!(
            comps == expected,
            "sampler output has {comps} components, expected {expected}"
        );
        let interpolation = match interp {
            "STEP" => Interpolation::Step,
            "CUBICSPLINE" => {
                // Keys are (in-tangent, value, out-tangent); keep the values.
                ensure!(
                    values.len() == times.len() * comps * 3,
                    "CUBICSPLINE output count mismatch"
                );
                values = (0..times.len())
                    .flat_map(|k| {
                        let base = (k * 3 + 1) * comps;
                        values[base..base + comps].to_vec()
                    })
                    .collect();
                Interpolation::Linear
            }
            _ => Interpolation::Linear,
        };
        ensure!(
            values.len() == times.len() * comps,
            "sampler output count mismatch"
        );
        duration = duration.max(times.last().copied().unwrap_or(0.0));
        channels.push(Channel {
            node: node as usize,
            path,
            interpolation,
            times,
            values,
        });
    }

    Ok(VrmaDoc {
        name,
        duration,
        humanoid,
        channels,
        nodes: GltfNodes::parse(&glb.json)?,
    })
}

/// Retarget a vrma clip onto a model: rotation channels transfer by humanoid
/// bone name, hips translation is scaled by the rest hips-height ratio and
/// re-anchored over the origin in X/Z, everything else is dropped.
///
/// `humanoid` is the model's bone map (e.g. [`crate::VrmDoc::humanoid`]);
/// `model_skeleton` supplies the model's rest globals for the hips height.
pub fn retarget(
    vrma: &VrmaDoc,
    humanoid: &[(String, usize)],
    model_skeleton: &Skeleton,
) -> Result<Clip> {
    let model_hips = humanoid
        .iter()
        .find(|(name, _)| name == "hips")
        .map(|&(_, node)| node)
        .context("model humanoid has no hips")?;
    ensure!(
        model_hips < model_skeleton.rest.len(),
        "model hips node out of range"
    );
    let vrma_hips = vrma.humanoid_node("hips");

    let model_h = channel_units_height(model_hips, &model_skeleton.parents, &model_skeleton.rest);
    ensure!(
        model_h > 1e-4,
        "model hips rest height is not positive ({model_h})"
    );

    // vrma node → bone name (first mapping wins; maps are tiny).
    let bone_of = |node: usize| -> Option<&str> {
        vrma.humanoid
            .iter()
            .find(|&&(_, n)| n == node)
            .map(|(name, _)| name.as_str())
    };

    let mut channels = Vec::new();
    for ch in &vrma.channels {
        let Some(bone) = bone_of(ch.node) else {
            continue; // non-humanoid channel: drop
        };
        let Some(model_node) = humanoid
            .iter()
            .find(|(name, _)| name == bone)
            .map(|&(_, node)| node)
        else {
            continue; // model lacks this bone: drop
        };
        match ch.path {
            ChannelPath::Rotation => {
                ensure!(
                    ch.node < vrma.nodes.rest.len(),
                    "vrma rotation node {} out of range",
                    ch.node
                );
                ensure!(
                    model_node < model_skeleton.rest.len(),
                    "model rotation node {model_node} out of range"
                );

                // Match three-vrm's normalized humanoid pipeline instead of
                // assigning the source rig's raw local quaternion directly:
                //
                //   normalized = sourceParentWorld * sourceLocal
                //                * inverse(sourceBoneWorldRest)
                //   targetLocal = inverse(targetParentWorld) * normalized
                //                 * targetParentWorld * targetLocalRest
                //
                // Hands and feet commonly have very different raw rest axes
                // between rigs, so skipping these basis changes produces the
                // most visible errors at wrists and ankles.
                let source_parent = source_humanoid_parent_rest_global_rotation(vrma, ch.node);
                let source_bone =
                    rest_global_rotation(ch.node, &vrma.nodes.parents, &vrma.nodes.rest);
                let target_parent = parent_rest_global_rotation(
                    model_node,
                    &model_skeleton.parents,
                    &model_skeleton.rest,
                );
                let target_rest = model_skeleton.rest[model_node].rotation;
                let values: Vec<f32> = ch
                    .values
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|q| {
                        let source_local = Quat::from_xyzw(q[0], q[1], q[2], q[3]).normalize();
                        let normalized =
                            (source_parent * source_local * source_bone.inverse()).normalize();
                        // VRMC_vrm_animation normalized poses face +Z; the
                        // only target format supported by pocket-vrm today is
                        // VRM 0.x, which faces -Z. Conjugating by a 180° yaw
                        // changes quaternion components to (-x, y, -z, w).
                        let normalized = Quat::from_xyzw(
                            -normalized.x,
                            normalized.y,
                            -normalized.z,
                            normalized.w,
                        );
                        let target_local =
                            (target_parent.inverse() * normalized * target_parent * target_rest)
                                .normalize();
                        target_local.to_array()
                    })
                    .collect();
                channels.push(Channel {
                    node: model_node,
                    path: ChannelPath::Rotation,
                    interpolation: ch.interpolation,
                    times: ch.times.clone(),
                    values,
                });
            }
            ChannelPath::Translation if bone == "hips" => {
                let hips_node = vrma_hips.context("vrma humanoid has no hips")?;
                ensure!(
                    hips_node < vrma.nodes.rest.len(),
                    "vrma hips node out of range"
                );
                let vrma_h = channel_units_height(hips_node, &vrma.nodes.parents, &vrma.nodes.rest);
                ensure!(
                    vrma_h > 1e-4,
                    "vrma hips rest height is not positive ({vrma_h})"
                );
                let scale = model_h / vrma_h;
                let mut values: Vec<f32> = ch.values.iter().map(|v| v * scale).collect();
                // Re-anchor: keep the loop centered over the origin in X/Z.
                // The same +Z→-Z yaw flip as rotations applies: negate X/Z.
                if values.len() >= 3 {
                    let (x0, z0) = (values[0], values[2]);
                    for key in values.as_chunks_mut::<3>().0 {
                        key[0] = -(key[0] - x0);
                        key[2] = -(key[2] - z0);
                    }
                }
                channels.push(Channel {
                    node: model_node,
                    path: ChannelPath::Translation,
                    interpolation: ch.interpolation,
                    times: ch.times.clone(),
                    values,
                });
            }
            _ => {} // non-hips translation, scale: drop
        }
    }
    if channels.is_empty() {
        bail!("retarget produced no channels (no humanoid overlap?)");
    }
    Ok(Clip {
        name: vrma.name.clone(),
        duration: vrma.duration,
        channels,
    })
}

/// Rest-pose world rotation of a node's immediate parent. Walking the chain
/// keeps this correct even when glTF node indices are not parents-first.
fn parent_rest_global_rotation(node: usize, parents: &[usize], rest: &[NodeTrs]) -> Quat {
    let parent = parents[node];
    if parent == usize::MAX {
        Quat::IDENTITY
    } else {
        rest_global_rotation(parent, parents, rest)
    }
}

/// Rest-pose world rotation of `node`, independent of glTF node index order.
fn rest_global_rotation(node: usize, parents: &[usize], rest: &[NodeTrs]) -> Quat {
    let mut transform = Mat4::IDENTITY;
    let mut chain = Vec::new();
    let mut current = node;
    while current != usize::MAX {
        chain.push(current);
        current = parents[current];
    }
    for ancestor in chain.into_iter().rev() {
        transform *= rest[ancestor].matrix();
    }
    three_decomposed_rotation(transform)
}

/// Match `THREE.Matrix4.decompose` followed by
/// `THREE.Quaternion.setFromRotationMatrix` for the world-space rest basis.
///
/// This deliberately does not use glam's matrix decomposition: the two
/// libraries choose different matrix-to-quaternion branches for shear, which
/// naturally appears below a rotated node with a non-uniformly scaled parent.
fn three_decomposed_rotation(transform: Mat4) -> Quat {
    let det = transform.determinant();
    if det == 0.0 {
        return Quat::IDENTITY;
    }

    // Three.js stores matrices column-major and removes the length of each
    // basis column before converting the remaining 3x3 to a quaternion.
    let mut sx = transform.x_axis.truncate().length();
    let sy = transform.y_axis.truncate().length();
    let sz = transform.z_axis.truncate().length();
    if det < 0.0 {
        sx = -sx;
    }

    let m11 = transform.x_axis.x / sx;
    let m21 = transform.x_axis.y / sx;
    let m31 = transform.x_axis.z / sx;
    let m12 = transform.y_axis.x / sy;
    let m22 = transform.y_axis.y / sy;
    let m32 = transform.y_axis.z / sy;
    let m13 = transform.z_axis.x / sz;
    let m23 = transform.z_axis.y / sz;
    let m33 = transform.z_axis.z / sz;

    // Exact branch structure from THREE.Quaternion.setFromRotationMatrix.
    let trace = m11 + m22 + m33;
    let rotation = if trace > 0.0 {
        let s = 0.5 / (trace + 1.0).sqrt();
        Quat::from_xyzw((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s)
    } else if m11 > m22 && m11 > m33 {
        let s = 2.0 * (1.0 + m11 - m22 - m33).sqrt();
        Quat::from_xyzw(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s)
    } else if m22 > m33 {
        let s = 2.0 * (1.0 + m22 - m11 - m33).sqrt();
        Quat::from_xyzw((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s)
    } else {
        let s = 2.0 * (1.0 + m33 - m11 - m22).sqrt();
        Quat::from_xyzw((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s)
    };
    rotation.normalize()
}

/// three-vrm normalizes a VRMA key relative to its closest mapped humanoid
/// parent, not necessarily the raw glTF node's immediate parent. If a bone is
/// the humanoid root, the hips node's raw parent provides that basis.
fn source_humanoid_parent_rest_global_rotation(vrma: &VrmaDoc, node: usize) -> Quat {
    let mut current = vrma.nodes.parents[node];
    while current != usize::MAX {
        if vrma.humanoid.iter().any(|&(_, mapped)| mapped == current) {
            return rest_global_rotation(current, &vrma.nodes.parents, &vrma.nodes.rest);
        }
        current = vrma.nodes.parents[current];
    }
    vrma.humanoid_node("hips").map_or_else(
        || parent_rest_global_rotation(node, &vrma.nodes.parents, &vrma.nodes.rest),
        |hips| parent_rest_global_rotation(hips, &vrma.nodes.parents, &vrma.nodes.rest),
    )
}

/// Rest-pose hips height in channel units: the parent chain accumulated
/// with rotations applied but ancestor scales ignored, because animation
/// translation keys are parent-local (see the module docs).
fn channel_units_height(node: usize, parents: &[usize], rest: &[NodeTrs]) -> f32 {
    let mut p = rest[node].translation;
    let mut cur = parents[node];
    while cur != usize::MAX {
        let t = &rest[cur];
        p = t.translation + t.rotation * p;
        cur = parents[cur];
    }
    p.y
}

#[cfg(test)]
mod tests {
    use glam::{Quat, Vec3};

    use super::*;

    /// Synthetic rig: vrma hips at rest height 2.0, model hips at 1.0 —
    /// hips translation must scale by 0.5 and re-anchor X/Z to the first key.
    #[test]
    fn retarget_scales_and_reanchors_hips() {
        let vrma = VrmaDoc {
            name: "test".into(),
            duration: 1.0,
            humanoid: vec![("hips".into(), 1), ("spine".into(), 2)],
            channels: vec![
                Channel {
                    node: 1,
                    path: ChannelPath::Translation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0, 1.0],
                    values: vec![1.0, 2.0, 3.0, 2.0, 2.2, 4.0],
                },
                Channel {
                    node: 2,
                    path: ChannelPath::Rotation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0, 1.0],
                    values: vec![
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0,
                        std::f32::consts::FRAC_1_SQRT_2,
                        0.0,
                        std::f32::consts::FRAC_1_SQRT_2,
                    ],
                },
                Channel {
                    // Not in the humanoid map: must be dropped.
                    node: 3,
                    path: ChannelPath::Rotation,
                    interpolation: Interpolation::Linear,
                    times: vec![0.0],
                    values: vec![0.0, 0.0, 0.0, 1.0],
                },
            ],
            nodes: {
                let mut rest = vec![NodeTrs::IDENTITY; 3];
                rest[1].translation = Vec3::new(0.0, 2.0, 0.0);
                GltfNodes {
                    names: vec!["root".into(), "hips".into(), "spine".into()],
                    parents: vec![usize::MAX, 0, 1],
                    rest,
                    children: vec![vec![1], vec![2], vec![]],
                }
            },
        };
        let mut rest = vec![NodeTrs::IDENTITY; 2];
        rest[1].translation = Vec3::new(0.0, 1.0, 0.0);
        let model = Skeleton {
            parents: vec![usize::MAX, 0],
            rest,
            order: vec![0, 1],
        };
        let humanoid = vec![("hips".to_string(), 1usize), ("spine".to_string(), 0)];
        let clip = retarget(&vrma, &humanoid, &model).unwrap();
        assert_eq!(clip.channels.len(), 2);
        let t = clip
            .channels
            .iter()
            .find(|c| c.path == ChannelPath::Translation)
            .unwrap();
        assert_eq!(t.node, 1);
        // Scaled by 0.5, X/Z re-anchored to key 0, then the +Z→-Z facing
        // flip negates X/Z.
        assert_eq!(t.values, vec![-0.0, 1.0, -0.0, -0.5, 1.1, -0.5]);
        let r = clip
            .channels
            .iter()
            .find(|c| c.path == ChannelPath::Rotation)
            .unwrap();
        assert_eq!(r.node, 0); // "spine" mapped onto model node 0
    }

    fn basis_retarget(normalized_pose: Quat) -> (Quat, Quat, Quat) {
        let source_parent = Quat::from_rotation_y(0.4);
        let source_helper = Quat::from_rotation_z(0.2);
        let source_rest = Quat::from_rotation_x(-0.7);
        let target_root = Quat::from_rotation_z(-0.3);
        let target_helper = Quat::from_rotation_x(0.15);
        let target_rest = Quat::from_rotation_y(0.8);
        let source_parent_trs = NodeTrs {
            rotation: source_parent,
            scale: Vec3::new(2.0, 1.0, 0.5),
            ..NodeTrs::IDENTITY
        };
        let source_helper_trs = NodeTrs {
            rotation: source_helper,
            scale: Vec3::new(0.7, 1.5, 1.1),
            ..NodeTrs::IDENTITY
        };
        let source_rest_trs = NodeTrs {
            rotation: source_rest,
            ..NodeTrs::IDENTITY
        };
        let target_root_trs = NodeTrs {
            translation: Vec3::Y,
            rotation: target_root,
            scale: Vec3::new(1.6, 0.8, 1.2),
        };
        let target_helper_trs = NodeTrs {
            rotation: target_helper,
            scale: Vec3::new(0.9, 1.4, 0.6),
            ..NodeTrs::IDENTITY
        };

        // Invert the loader's source-normalization formula to author a raw
        // source key representing `normalized_pose`. The unmapped helper node
        // and non-uniform scales cover full matrixWorld decomposition.
        let source_parent_world = three_decomposed_rotation(source_parent_trs.matrix());
        let source_bone_world = three_decomposed_rotation(
            source_parent_trs.matrix() * source_helper_trs.matrix() * source_rest_trs.matrix(),
        );
        let source_key =
            (source_parent_world.inverse() * normalized_pose * source_bone_world).normalize();
        let vrma = VrmaDoc {
            name: "basis".into(),
            duration: 1.0,
            humanoid: vec![("hips".into(), 0), ("leftHand".into(), 2)],
            channels: vec![Channel {
                node: 2,
                path: ChannelPath::Rotation,
                interpolation: Interpolation::Linear,
                times: vec![0.0],
                values: source_key.to_array().to_vec(),
            }],
            nodes: GltfNodes {
                names: vec![
                    "source-hips".into(),
                    "source-helper".into(),
                    "source-hand".into(),
                ],
                parents: vec![usize::MAX, 0, 1],
                rest: vec![source_parent_trs, source_helper_trs, source_rest_trs],
                children: vec![vec![1], vec![2], vec![]],
            },
        };
        let model = Skeleton {
            parents: vec![usize::MAX, 0, 1],
            rest: vec![
                target_root_trs,
                target_helper_trs,
                NodeTrs {
                    rotation: target_rest,
                    ..NodeTrs::IDENTITY
                },
            ],
            order: vec![0, 1, 2],
        };

        let clip = retarget(&vrma, &[("hips".into(), 0), ("leftHand".into(), 2)], &model)
            .expect("retarget");
        let actual = Quat::from_array(clip.channels[0].values[..4].try_into().unwrap());
        let flipped_pose = Quat::from_xyzw(
            -normalized_pose.x,
            normalized_pose.y,
            -normalized_pose.z,
            normalized_pose.w,
        );
        let target_parent =
            three_decomposed_rotation(target_root_trs.matrix() * target_helper_trs.matrix());
        let expected =
            (target_parent.inverse() * flipped_pose * target_parent * target_rest).normalize();
        (actual, expected, target_rest)
    }

    #[test]
    fn retarget_converts_between_source_and_target_bone_bases() {
        let (actual, expected, _) = basis_retarget(Quat::from_rotation_x(0.25));
        assert!(
            actual.angle_between(expected) < 1e-5,
            "actual={actual:?} expected={expected:?}"
        );
    }

    #[test]
    fn retarget_maps_source_rest_to_target_rest() {
        let (actual, expected, target_rest) = basis_retarget(Quat::IDENTITY);
        assert!(
            actual.angle_between(expected) < 1e-5 && actual.angle_between(target_rest) < 1e-5,
            "actual={actual:?} expected={expected:?} target_rest={target_rest:?}"
        );
    }

    #[test]
    fn rest_world_rotation_matches_three_decomposition_under_shear() {
        // A rotated child below a non-uniformly scaled parent produces shear.
        // This hard-coded golden comes from Three.js 0.180.0 Matrix4.decompose;
        // glam's generic decomposition differs by about 1.84 radians here.
        let root = NodeTrs {
            rotation: Quat::from_rotation_x(2.5),
            scale: Vec3::new(3.0, 0.5, 1.0),
            ..NodeTrs::IDENTITY
        };
        let child = NodeTrs {
            rotation: Quat::from_rotation_z(0.75),
            scale: Vec3::new(0.7, 2.0, 1.3),
            ..NodeTrs::IDENTITY
        };
        let actual = rest_global_rotation(1, &[usize::MAX, 0], &[root, child]);
        let expected = Quat::from_xyzw(0.460_139_9, -0.060_026_97, 0.563_158_1, 0.683_755_1);
        assert!(
            actual.angle_between(expected) < 1e-5,
            "actual={actual:?} expected={expected:?}"
        );

        let singular = Mat4::from_scale(Vec3::new(1.0, 0.0, 1.0));
        assert_eq!(three_decomposed_rotation(singular), Quat::IDENTITY);
    }
}
