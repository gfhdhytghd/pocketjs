//! Retained accessibility metadata. Geometry and platform projection are separate
//! from these author-provided properties and must use the committed native tree.
use alloc::string::String;
use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Role {
    Text,
    Button,
    Image,
    Header,
    Link,
    Checkbox,
    Switch,
    Adjustable,
    List,
    ListItem,
}
impl Role {
    pub fn from_code(code: i32) -> Option<Self> {
        Some(match code {
            0 => Self::Text,
            1 => Self::Button,
            2 => Self::Image,
            3 => Self::Header,
            4 => Self::Link,
            5 => Self::Checkbox,
            6 => Self::Switch,
            7 => Self::Adjustable,
            8 => Self::List,
            9 => Self::ListItem,
            _ => return None,
        })
    }
}

pub const DISABLED: u16 = 1;
pub const SELECTED: u16 = 2;
pub const CHECKED: u16 = 4;
pub const MIXED: u16 = 8;
pub const EXPANDED: u16 = 16;
pub const BUSY: u16 = 32;
pub const HAS_CHECKED: u16 = 64;
pub const HAS_EXPANDED: u16 = 128;
pub const HIDDEN: u16 = 256;
pub const ACTIVATE: u8 = 1;
pub const INCREMENT: u8 = 2;
pub const DECREMENT: u8 = 4;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Properties {
    /// None uses the native text/default label; Some("") is an explicit empty label.
    pub label: Option<String>,
    pub role: Option<Role>,
    pub value: Option<String>,
    pub hint: Option<String>,
    pub state: u16,
    pub actions: u8,
    pub pressable: bool,
}
impl Properties {
    pub fn valid(&self) -> bool {
        self.state & !511 == 0
            && self.actions & !7 == 0
            && (self.state & (CHECKED | MIXED) == 0 || self.state & HAS_CHECKED != 0)
            && self.state & (CHECKED | MIXED) != (CHECKED | MIXED)
            && (self.state & EXPANDED == 0 || self.state & HAS_EXPANDED != 0)
            && [&self.label, &self.value, &self.hint]
                .iter()
                .all(|s| s.as_ref().is_none_or(|s| s.len() <= 4096))
    }
}

/// Conservative clipped logical border-box bounds captured by the paint walk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticNode {
    pub id: i32,
    /// Nearest exposed ancestor, or 0 for a top-level semantic node.
    pub parent_id: i32,
    pub role: Role,
    pub label: String,
    pub value: Option<String>,
    pub hint: Option<String>,
    pub state: u16,
    pub actions: u8,
    pub bounds: Bounds,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub nodes: Vec<SemanticNode>,
    pub content_hash: u64,
    pub frame_number: u64,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            nodes: Vec::new(),
            content_hash: 0xcbf29ce484222325,
            frame_number: 0,
        }
    }
}

fn independent(node: &crate::tree::Node) -> bool {
    let p = &node.accessibility;
    p.pressable
        || p.actions != 0
        || matches!(
            p.role,
            Some(
                Role::Button
                    | Role::Link
                    | Role::Checkbox
                    | Role::Switch
                    | Role::Adjustable
                    | Role::List
            )
        )
}

impl crate::Ui {
    /// Validate a platform action against both published semantics and live ownership.
    /// This does not execute callbacks or commit pending layout mutations.
    pub fn accepts_accessibility_action(&self, id: i32, hash: u64, action: u8) -> bool {
        if !self.accessibility_enabled
            || !matches!(action, ACTIVATE | INCREMENT | DECREMENT)
            || self.semantic_snapshot.content_hash != hash
            || !self.semantic_snapshot.nodes.iter().any(|n| n.id == id && n.actions & action != 0)
        {
            return false;
        }
        let Some(target) = self.tree.get(id) else { return false; };
        let actions = target.accessibility.actions
            | if target.accessibility.pressable { ACTIVATE } else { 0 };
        if actions & action == 0 { return false; }
        let mut cursor = id;
        loop {
            let Some(node) = self.tree.get(cursor) else { return false; };
            if node.accessibility.state & (DISABLED | HIDDEN) != 0 { return false; }
            if cursor == crate::spec::ROOT_ID { return true; }
            if node.parent == 0 { return false; }
            cursor = node.parent;
        }
    }
}
fn role(node: &crate::tree::Node) -> Option<Role> {
    let p = &node.accessibility;
    if let Some(role) = p.role {
        return Some(role);
    }
    if p.pressable || p.actions & ACTIVATE != 0 {
        return Some(Role::Button);
    }
    if p.actions & (INCREMENT | DECREMENT) != 0 {
        return Some(Role::Adjustable);
    }
    if node.node_type == crate::spec::NodeType::Text as u8 {
        return Some(Role::Text);
    }
    if node.node_type == crate::spec::NodeType::Image as u8 {
        return p.label.as_ref().map(|_| Role::Image); // Unlabelled images are decorative.
    }
    if p.label.is_some() || p.value.is_some() {
        Some(Role::Text)
    } else {
        None
    }
}
fn normalized(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Native Text nodes absorb their descendants into one painted run. Inline
// descendants have no separate layout box; merge them without inventing geometry.
fn inline_text(tree: &crate::tree::Tree, id: i32, out: &mut String) {
    let Some(node) = tree.get(id) else {
        return;
    };
    if node.accessibility.state & HIDDEN != 0 {
        return;
    }
    if let Some(label) = &node.accessibility.label {
        out.push_str(label);
        return;
    }
    out.push_str(&node.text);
    for child in &node.children {
        inline_text(tree, *child, out);
    }
}
fn passive_labels(
    tree: &crate::tree::Tree,
    geometry: &[Option<Bounds>],
    id: i32,
    out: &mut Vec<String>,
) {
    let Some(slot) = tree.resolve(id) else {
        return;
    };
    let node = &tree.slots[slot as usize];
    if node.accessibility.state & HIDDEN != 0 || independent(node) {
        return;
    }
    let visible = geometry.get(slot as usize).is_some_and(Option::is_some);
    if visible {
        if let Some(label) = &node.accessibility.label {
            out.push(label.clone());
            return;
        }
        if node.node_type == crate::spec::NodeType::Text as u8 {
            let mut text = String::new();
            inline_text(tree, id, &mut text);
            out.push(text);
            return;
        }
    } else if node.node_type == crate::spec::NodeType::Text as u8 {
        return;
    }
    for child in &node.children {
        passive_labels(tree, geometry, *child, out);
    }
}
fn label(tree: &crate::tree::Tree, geometry: &[Option<Bounds>], id: i32, role: Role) -> String {
    let node = tree.get(id).unwrap();
    if let Some(label) = &node.accessibility.label {
        return label.clone();
    }
    if node.node_type == crate::spec::NodeType::Text as u8 {
        let mut text = String::new();
        inline_text(tree, id, &mut text);
        return normalized(&text);
    }
    if role == Role::List {
        return String::new();
    }
    let mut parts = Vec::new();
    for child in &node.children {
        passive_labels(tree, geometry, *child, &mut parts);
    }
    normalized(&parts.join(" "))
}
fn walk(
    tree: &crate::tree::Tree,
    geometry: &[Option<Bounds>],
    id: i32,
    parent: i32,
    merged: bool,
    disabled: bool,
    out: &mut Vec<SemanticNode>,
) {
    let Some(slot) = tree.resolve(id) else {
        return;
    };
    let node = &tree.slots[slot as usize];
    let p = &node.accessibility;
    if p.state & HIDDEN != 0 {
        return;
    }
    let disabled = disabled || p.state & DISABLED != 0;
    let mut parent = parent;
    let mut merged = merged;
    if let (Some(role), Some(Some(bounds))) = (role(node), geometry.get(slot as usize)) {
        if !merged || independent(node) {
            out.push(SemanticNode {
                id,
                parent_id: parent,
                role,
                label: label(tree, geometry, id, role),
                value: p.value.clone(),
                hint: p.hint.clone(),
                state: p.state & !HIDDEN | if disabled { DISABLED } else { 0 },
                actions: if disabled {
                    0
                } else {
                    p.actions | if p.pressable { ACTIVATE } else { 0 }
                },
                bounds: *bounds,
            });
            parent = id;
            merged = role != Role::List;
        }
    }
    if node.node_type == crate::spec::NodeType::Text as u8 {
        return;
    }
    // Source order, never z-index/coordinate/depth order. Detached/stale children
    // are absent from the committed traversal and cannot retain virtual focus ids.
    for child in &node.children {
        walk(tree, geometry, *child, parent, merged, disabled, out);
    }
}

pub(crate) fn snapshot(
    tree: &crate::tree::Tree,
    geometry: &[Option<Bounds>],
    root: i32,
) -> Snapshot {
    let mut result = Snapshot::default();
    walk(tree, geometry, root, 0, false, false, &mut result.nodes);
    fn bytes(hash: &mut u64, bytes: &[u8]) {
        for byte in bytes {
            *hash = (*hash ^ *byte as u64).wrapping_mul(0x100000001b3);
        }
    }
    fn text(hash: &mut u64, text: Option<&str>) {
        let length = text.map_or(u64::MAX, |text| text.len() as u64);
        bytes(hash, &length.to_le_bytes());
        if let Some(text) = text {
            bytes(hash, text.as_bytes());
        }
    }
    for node in &result.nodes {
        let hash = &mut result.content_hash;
        bytes(hash, &node.id.to_le_bytes());
        bytes(hash, &node.parent_id.to_le_bytes());
        bytes(hash, &[node.role as u8]);
        text(hash, Some(&node.label));
        text(hash, node.value.as_deref());
        text(hash, node.hint.as_deref());
        bytes(hash, &node.state.to_le_bytes());
        bytes(hash, &[node.actions]);
        for value in [
            node.bounds.left,
            node.bounds.top,
            node.bounds.right,
            node.bounds.bottom,
        ] {
            bytes(hash, &value.to_le_bytes());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{spec, Ui};
    fn box_node(ui: &mut Ui, parent: i32, kind: u8, x: f64, y: f64, w: f64, h: f64) -> i32 {
        let id = ui.create_node(kind);
        for (prop, value) in [
            (spec::prop::POS_TYPE, 1.0),
            (spec::prop::INSET_L, x),
            (spec::prop::INSET_T, y),
            (spec::prop::WIDTH, w),
            (spec::prop::HEIGHT, h),
        ] {
            ui.set_prop(id, prop, value);
        }
        ui.insert_before(parent, id, 0);
        id
    }
    fn expected(
        id: i32,
        parent_id: i32,
        role: Role,
        label: &str,
        bounds: Bounds,
        actions: u8,
    ) -> SemanticNode {
        SemanticNode {
            id,
            parent_id,
            role,
            label: String::from(label),
            value: None,
            hint: None,
            state: 0,
            actions,
            bounds,
        }
    }
    #[test]
    fn committed_semantic_tree_golden_merges_labels_but_preserves_nested_controls() {
        let mut ui = Ui::new();
        ui.set_viewport(240.0, 240.0);
        ui.set_accessibility_enabled(true);
        let button = box_node(&mut ui, 1, 0, 20.0, 20.0, 100.0, 50.0);
        ui.set_accessibility(
            button,
            Properties {
                pressable: true,
                ..Properties::default()
            },
        );
        let text = box_node(&mut ui, button, 1, 0.0, 0.0, 50.0, 20.0);
        ui.set_text(text, "Save");
        let inline = ui.create_node(1);
        ui.set_text(inline, " now");
        ui.insert_before(text, inline, 0);
        let secret = ui.create_node(1);
        ui.set_text(secret, " secret");
        ui.insert_before(text, secret, 0);
        ui.set_accessibility(
            secret,
            Properties {
                state: HIDDEN,
                ..Properties::default()
            },
        );
        let more = box_node(&mut ui, button, 0, 70.0, 0.0, 20.0, 20.0);
        ui.set_accessibility(
            more,
            Properties {
                pressable: true,
                label: Some(String::from("More")),
                ..Properties::default()
            },
        );
        box_node(&mut ui, 1, 2, 0.0, 100.0, 20.0, 20.0); // Decorative image is omitted.
        let logo = box_node(&mut ui, 1, 2, 30.0, 100.0, 20.0, 20.0);
        ui.set_accessibility(
            logo,
            Properties {
                label: Some(String::from("Logo")),
                ..Properties::default()
            },
        );
        let hidden = box_node(&mut ui, 1, 0, 0.0, 130.0, 50.0, 20.0);
        ui.set_accessibility(
            hidden,
            Properties {
                state: HIDDEN,
                ..Properties::default()
            },
        );
        let hidden_text = box_node(&mut ui, hidden, 1, 0.0, 0.0, 50.0, 20.0);
        ui.set_text(hidden_text, "Hidden");
        let last = box_node(&mut ui, 1, 1, 0.0, 180.0, 50.0, 20.0);
        ui.set_text(last, "Last");
        ui.set_prop(button, spec::prop::Z_INDEX, 100.0); // Paints last, still reads first.
        ui.draw();
        assert_eq!(
            ui.current_accessibility().nodes,
            alloc::vec![
                expected(
                    button,
                    0,
                    Role::Button,
                    "Save now",
                    Bounds {
                        left: 20,
                        top: 20,
                        right: 120,
                        bottom: 70
                    },
                    ACTIVATE
                ),
                expected(
                    more,
                    button,
                    Role::Button,
                    "More",
                    Bounds {
                        left: 90,
                        top: 20,
                        right: 110,
                        bottom: 40
                    },
                    ACTIVATE
                ),
                expected(
                    logo,
                    0,
                    Role::Image,
                    "Logo",
                    Bounds {
                        left: 30,
                        top: 100,
                        right: 50,
                        bottom: 120
                    },
                    0
                ),
                expected(
                    last,
                    0,
                    Role::Text,
                    "Last",
                    Bounds {
                        left: 0,
                        top: 180,
                        right: 50,
                        bottom: 200
                    },
                    0
                ),
            ]
        );
    }
    #[test]
    fn semantic_hash_changes_only_at_commit_and_only_for_semantic_content() {
        let mut ui = Ui::new();
        let node = box_node(&mut ui, 1, 1, 5.0, 7.0, 70.0, 20.0);
        ui.set_text(node, "Before");
        let painted=ui.draw().words.clone();
        assert!(ui.current_accessibility().nodes.is_empty());
        ui.set_accessibility_enabled(true);
        assert_eq!(ui.draw().words,painted);
        let first = ui.current_accessibility().clone();
        ui.set_prop(node, spec::prop::BG_COLOR, 0xff0000ff_u32 as f64);
        ui.draw();
        assert_eq!(&first, ui.current_accessibility());
        ui.set_text(node, "After");
        assert_eq!(&first, ui.current_accessibility());
        ui.draw();
        assert_ne!(first.content_hash, ui.current_accessibility().content_hash);
        let second = ui.current_accessibility().content_hash;
        ui.draw();
        assert_eq!(second, ui.current_accessibility().content_hash);
        ui.set_prop(node, spec::prop::TRANSLATE_X, 1.0);
        ui.draw();
        assert_ne!(second, ui.current_accessibility().content_hash);
        ui.set_accessibility_enabled(false);
        assert!(ui.current_accessibility().nodes.is_empty());
    }
    #[test]
    fn semantics_uses_paint_clip_scale_and_perspective_geometry() {
        let mut ui = Ui::new();
        ui.set_viewport(240.0, 240.0);
        ui.set_accessibility_enabled(true);
        let clip = box_node(&mut ui, 1, 0, 10.0, 20.0, 40.0, 40.0);
        ui.set_prop(
            clip,
            spec::prop::OVERFLOW,
            spec::Overflow::Hidden as u8 as f64,
        );
        let child = box_node(&mut ui, clip, 1, 30.0, 10.0, 30.0, 20.0);
        ui.set_text(child, "Clipped");
        ui.draw();
        assert_eq!(
            ui.current_accessibility().nodes[0].bounds,
            Bounds {
                left: 40,
                top: 30,
                right: 50,
                bottom: 50
            }
        );
        ui.set_prop(clip, spec::prop::ORIGIN_X, -0.5);
        ui.set_prop(clip, spec::prop::ORIGIN_Y, -0.5);
        ui.set_prop(clip, spec::prop::SCALE, 2.0);
        ui.draw();
        assert_eq!(
            ui.current_accessibility().nodes[0].bounds,
            Bounds {
                left: 70,
                top: 40,
                right: 90,
                bottom: 80
            }
        );
        let stage = box_node(&mut ui, 1, 0, 100.0, 100.0, 100.0, 100.0);
        ui.set_prop(stage, spec::prop::PERSPECTIVE, 200.0);
        let face = box_node(&mut ui, stage, 0, 25.0, 25.0, 50.0, 50.0);
        ui.set_prop(face, spec::prop::TRANSLATE_Z, 100.0);
        ui.set_accessibility(
            face,
            Properties {
                label: Some(String::from("Perspective")),
                ..Properties::default()
            },
        );
        ui.draw();
        assert_eq!(
            ui.current_accessibility()
                .nodes
                .iter()
                .find(|node| node.id == face)
                .unwrap()
                .bounds,
            Bounds {
                left: 100,
                top: 100,
                right: 200,
                bottom: 200
            }
        );
    }
    #[test]
    fn hidden_offscreen_disabled_and_reused_nodes_keep_action_and_identity_rules() {
        let mut ui = Ui::new();
        ui.set_viewport(240.0, 240.0);
        ui.set_accessibility_enabled(true);
        let parent = box_node(&mut ui, 1, 0, 0.0, 0.0, 100.0, 100.0);
        ui.set_accessibility(
            parent,
            Properties {
                state: DISABLED,
                ..Properties::default()
            },
        );
        let control = box_node(&mut ui, parent, 0, 0.0, 0.0, 50.0, 50.0);
        ui.set_accessibility(
            control,
            Properties {
                label: Some(String::from("Value")),
                role: Some(Role::Adjustable),
                actions: INCREMENT | DECREMENT,
                ..Properties::default()
            },
        );
        let outside = box_node(&mut ui, 1, 1, 300.0, 0.0, 30.0, 30.0);
        ui.set_text(outside, "Outside");
        let transparent = box_node(&mut ui, 1, 1, 0.0, 100.0, 30.0, 30.0);
        ui.set_text(transparent, "Invisible");
        ui.set_prop(transparent, spec::prop::OPACITY, 0.0);
        ui.draw();
        assert_eq!(ui.current_accessibility().nodes.len(), 1);
        assert_eq!(ui.current_accessibility().nodes[0].state, DISABLED);
        assert_eq!(ui.current_accessibility().nodes[0].actions, 0);
        ui.set_accessibility(parent, Properties::default());
        ui.draw();
        assert_eq!(
            ui.current_accessibility().nodes[0].actions,
            INCREMENT | DECREMENT
        );
        let previous = ui.current_accessibility().content_hash;
        ui.destroy_node(control);
        let replacement = box_node(&mut ui, parent, 0, 0.0, 0.0, 50.0, 50.0);
        assert_ne!(control, replacement);
        ui.draw();
        assert!(ui.current_accessibility().nodes.is_empty());
        assert_ne!(previous, ui.current_accessibility().content_hash);
    }
    #[test]
    fn action_validation_rejects_stale_or_revoked_requests_before_next_draw() {
        let mut ui = Ui::new();
        ui.set_viewport(240.0, 240.0);
        ui.set_accessibility_enabled(true);
        let parent = box_node(&mut ui, 1, 0, 0.0, 0.0, 100.0, 100.0);
        let id = box_node(&mut ui, parent, 0, 0.0, 0.0, 50.0, 50.0);
        let props = Properties { pressable: true, ..Properties::default() };
        ui.set_accessibility(id, props.clone());
        ui.draw();
        let hash = ui.current_accessibility().content_hash;
        assert!(ui.accepts_accessibility_action(id, hash, ACTIVATE));
        for action in [0, INCREMENT, DECREMENT, 3, 255] {
            assert!(!ui.accepts_accessibility_action(id, hash, action));
        }
        assert!(!ui.accepts_accessibility_action(id, hash ^ 1, ACTIVATE));
        ui.set_accessibility(id, Properties::default());
        assert!(!ui.accepts_accessibility_action(id, hash, ACTIVATE));
        ui.set_accessibility(id, props);
        for state in [DISABLED, HIDDEN] {
            ui.set_accessibility(parent, Properties { state, ..Properties::default() });
            assert!(!ui.accepts_accessibility_action(id, hash, ACTIVATE));
        }
        ui.set_accessibility(parent, Properties::default());
        ui.remove_child(parent, id);
        assert!(!ui.accepts_accessibility_action(id, hash, ACTIVATE));
        ui.insert_before(parent, id, 0);
        assert!(ui.accepts_accessibility_action(id, hash, ACTIVATE));
        ui.destroy_node(id);
        assert!(!ui.accepts_accessibility_action(id, hash, ACTIVATE));
        ui.set_accessibility_enabled(false);
        assert!(!ui.accepts_accessibility_action(id, hash, ACTIVATE));
    }

    #[test]
    fn atomic_metadata_updates_and_generation_reuse() {
        let mut ui = crate::Ui::new();
        let node = ui.create_node(crate::spec::NodeType::View as u8);
        let value = Properties {
            label: Some(String::from("批准😀")),
            role: Some(Role::Button),
            pressable: true,
            ..Properties::default()
        };
        assert!(ui.set_accessibility(node, value.clone()));
        assert_eq!(ui.accessibility_of(node), Some(&value));
        assert!(!ui.set_accessibility(
            node,
            Properties {
                state: 512,
                ..Properties::default()
            }
        ));
        assert_eq!(ui.accessibility_of(node), Some(&value));
        ui.destroy_node(node);
        let next = ui.create_node(crate::spec::NodeType::View as u8);
        assert_ne!(next, node);
        assert!(!ui.set_accessibility(node, value));
        assert_eq!(ui.accessibility_of(next), Some(&Properties::default()));
    }
    #[test]
    fn metadata_rejects_inconsistent_flags_and_oversized_text() {
        for state in [CHECKED, MIXED, EXPANDED, HAS_CHECKED | CHECKED | MIXED, 512] {
            assert!(!Properties {
                state,
                ..Properties::default()
            }
            .valid());
        }
        assert!(Properties {
            state: HAS_CHECKED | MIXED | HAS_EXPANDED | EXPANDED | HIDDEN,
            actions: 7,
            ..Properties::default()
        }
        .valid());
        assert!(!Properties {
            label: Some("x".repeat(4097)),
            ..Properties::default()
        }
        .valid());
        assert!(!Properties {
            actions: 8,
            ..Properties::default()
        }
        .valid());
    }
}
