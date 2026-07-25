//! The dialogue box: wrapping, the typewriter reveal, paging and choices.
//!
//! Ported from upstream `src/render/TextBox.lua`. The control codes are the
//! original engine's, because every line of dialogue in the content is written
//! against them:
//!
//! | code | meaning |
//! | --- | --- |
//! | `\n` | hard line break within the page |
//! | `\v` | scroll: the box advances one line, keeping the last line visible |
//! | `\f` | page break: wait for A, then clear and continue |
//!
//! Wrapping is greedy by word and measured through the loaded font, so a
//! translated or modded font changes the line breaks without touching content.

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::content::Content;
use crate::event::{EventQueue, MonEvent};
use crate::spec;

/// Lines visible in the box at once.
pub const LINES: usize = 3;
/// Inner width available to glyphs, in logical pixels.
pub const BOX_INNER_W: i32 = spec::VIEW_W - 16;
/// Frames between revealed characters (the typewriter speed).
pub const TYPE_DELAY: u8 = 2;
/// Fallback advance for a codepoint the font does not carry.
const DEFAULT_ADVANCE: u8 = 8;
/// `\v` — scroll one line. Rust has no `\v` escape, so the control characters
/// are spelled out; content authors still write them as `\v` / `\f` in TS.
pub const VERT_TAB: char = '\u{0b}';
/// `\f` — page break.
pub const FORM_FEED: char = '\u{0c}';

/// One laid-out page: up to `LINES` lines of text.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub lines: Vec<String>,
}

impl Page {
    /// Total characters on the page — the typewriter's target.
    fn char_count(&self) -> usize {
        self.lines.iter().map(|l| l.chars().count()).sum()
    }
}

/// A pending choice prompt.
#[derive(Clone, Debug, Default)]
pub struct Choice {
    pub options: Vec<String>,
    pub cursor: u8,
}

/// The dialogue box state machine.
#[derive(Clone, Debug, Default)]
pub struct TextBox {
    pages: Vec<Page>,
    page: usize,
    /// Characters revealed on the current page.
    revealed: usize,
    delay: u8,
    handle: i32,
    next_handle: i32,
    open: bool,
    choice: Option<Choice>,
    /// Set once the current page is fully revealed (the "▼" prompt shows).
    pub page_done: bool,
}

impl TextBox {
    pub fn new() -> Self {
        TextBox { next_handle: 1, ..Default::default() }
    }

    pub fn active(&self) -> bool {
        self.open
    }

    pub fn handle(&self) -> i32 {
        self.handle
    }

    /// The page currently on screen.
    pub fn current(&self) -> Option<&Page> {
        self.pages.get(self.page)
    }

    /// How many characters of the current page are visible.
    pub fn revealed(&self) -> usize {
        self.revealed
    }

    pub fn choice(&self) -> Option<&Choice> {
        self.choice.as_ref()
    }

    /// Show a string. Returns a handle the guest matches against `textDone`.
    pub fn show(&mut self, content: &Content, s: &str) -> i32 {
        self.pages = layout(content, s);
        self.page = 0;
        self.revealed = 0;
        self.delay = 0;
        self.open = !self.pages.is_empty();
        self.page_done = false;
        self.choice = None;
        self.handle = self.next_handle;
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        self.handle
    }

    /// Show a string that ends in a choice. The choice appears once the last
    /// page is fully revealed.
    pub fn show_choice(&mut self, content: &Content, s: &str, options: &[&str]) -> i32 {
        let h = self.show(content, s);
        self.choice = Some(Choice {
            options: options.iter().map(|o| o.to_string()).collect(),
            cursor: 0,
        });
        h
    }

    /// Close immediately, without emitting a completion event.
    pub fn close(&mut self) {
        self.open = false;
        self.pages.clear();
        self.choice = None;
        self.page_done = false;
        self.revealed = 0;
    }

    /// Advance one frame.
    pub fn tick(&mut self, pressed: u32, events: &mut EventQueue) {
        if !self.open {
            return;
        }
        let total = self.current().map(Page::char_count).unwrap_or(0);

        // Typewriter.
        if self.revealed < total {
            // A press fast-forwards the reveal rather than skipping the page:
            // the original's "hold A to speed up text" without dropping a line.
            if pressed & (spec::btn::A | spec::btn::B) != 0 {
                self.revealed = total;
            } else if self.delay == 0 {
                self.revealed += 1;
                self.delay = TYPE_DELAY;
            } else {
                self.delay -= 1;
            }
            self.page_done = self.revealed >= total;
            return;
        }
        self.page_done = true;

        // A choice owns the input once its text is up.
        if let Some(c) = self.choice.as_mut() {
            let n = c.options.len() as u8;
            if n > 0 {
                if pressed & spec::btn::UP != 0 {
                    c.cursor = (c.cursor + n - 1) % n;
                }
                if pressed & spec::btn::DOWN != 0 {
                    c.cursor = (c.cursor + 1) % n;
                }
                if pressed & spec::btn::A != 0 {
                    let idx = c.cursor as i32;
                    let h = self.handle;
                    self.close();
                    events.push(MonEvent {
                        kind: spec::event::CHOICE_DONE,
                        a: 0,
                        b: h,
                        c: idx,
                        d: 0,
                    });
                }
                // B cancels to the LAST option, the universal "no" convention.
                if pressed & spec::btn::B != 0 {
                    let idx = (n - 1) as i32;
                    let h = self.handle;
                    self.close();
                    events.push(MonEvent {
                        kind: spec::event::CHOICE_DONE,
                        a: 0,
                        b: h,
                        c: idx,
                        d: 0,
                    });
                }
            }
            return;
        }

        if pressed & spec::btn::A != 0 {
            if self.page + 1 < self.pages.len() {
                self.page += 1;
                self.revealed = 0;
                self.delay = 0;
                self.page_done = false;
            } else {
                let h = self.handle;
                self.close();
                events.push(MonEvent {
                    kind: spec::event::TEXT_DONE,
                    a: 0,
                    b: h,
                    c: 0,
                    d: 0,
                });
            }
        }
    }
}

/// Advance width of one character through the loaded font.
pub fn advance(content: &Content, ch: char) -> i32 {
    content
        .glyph(ch as u32)
        .map(|g| g.advance)
        .unwrap_or(DEFAULT_ADVANCE) as i32
}

/// Pixel width of a string.
pub fn measure(content: &Content, s: &str) -> i32 {
    s.chars().map(|c| advance(content, c)).sum()
}

/// Lay a string out into pages of wrapped lines.
///
/// Greedy word wrap: a word that does not fit starts the next line; a word
/// longer than the whole box is broken mid-word rather than overflowing.
pub fn layout(content: &Content, s: &str) -> Vec<Page> {
    let mut pages: Vec<Page> = Vec::new();
    let mut page = Page::default();
    let mut line = String::new();
    let mut line_w = 0;

    // Push the working line into the page; start a new page when full.
    fn flush_line(pages: &mut Vec<Page>, page: &mut Page, line: &mut String, line_w: &mut i32) {
        page.lines.push(core::mem::take(line));
        *line_w = 0;
        if page.lines.len() >= LINES {
            pages.push(core::mem::take(page));
        }
    }

    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\n' => flush_line(&mut pages, &mut page, &mut line, &mut line_w),
            VERT_TAB => {
                // Scroll: end the line and, if the page is full, roll it over
                // keeping the last line as context.
                flush_line(&mut pages, &mut page, &mut line, &mut line_w);
                if page.lines.len() >= LINES {
                    pages.push(core::mem::take(&mut page));
                }
            }
            FORM_FEED => {
                if !line.is_empty() {
                    flush_line(&mut pages, &mut page, &mut line, &mut line_w);
                }
                if !page.lines.is_empty() {
                    pages.push(core::mem::take(&mut page));
                }
            }
            ' ' => {
                // Measure the upcoming word to decide whether the space fits.
                let mut word_w = 0;
                let mut probe = chars.clone();
                while let Some(&c) = probe.peek() {
                    if c == ' ' || c == '\n' || c == VERT_TAB || c == FORM_FEED {
                        break;
                    }
                    word_w += advance(content, c);
                    probe.next();
                }
                let space_w = advance(content, ' ');
                if line_w + space_w + word_w > BOX_INNER_W && !line.is_empty() {
                    flush_line(&mut pages, &mut page, &mut line, &mut line_w);
                } else if !line.is_empty() {
                    line.push(' ');
                    line_w += space_w;
                }
            }
            _ => {
                let w = advance(content, ch);
                if line_w + w > BOX_INNER_W && !line.is_empty() {
                    flush_line(&mut pages, &mut page, &mut line, &mut line_w);
                }
                line.push(ch);
                line_w += w;
            }
        }
    }
    if !line.is_empty() {
        page.lines.push(line);
    }
    if !page.lines.is_empty() {
        pages.push(page);
    }
    pages
}

/// Format an unsigned number into a fixed-width, space-padded string — the
/// HUD's money and HP counters, without a formatter in no_std.
pub fn pad_num(value: u32, width: usize) -> String {
    let mut s = value.to_string();
    while s.len() < width {
        s.insert(0, ' ');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::Glyph;

    /// A font where every glyph advances 8 px, so widths are predictable.
    fn font() -> Content {
        let mut c = Content::new();
        for cp in 32u32..127 {
            c.glyphs.push(Glyph { codepoint: cp, u: 0, v: 0, w: 8, h: 8, advance: 8 });
        }
        c.glyphs.sort_unstable_by_key(|g| g.codepoint);
        c.font_line_height = 10;
        c
    }

    #[test]
    fn short_text_is_one_page_one_line() {
        let c = font();
        let pages = layout(&c, "HELLO");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].lines, alloc::vec!["HELLO"]);
    }

    #[test]
    fn wrapping_breaks_on_words_not_mid_word() {
        let c = font();
        // 28 glyphs fit per line (224 / 8).
        let pages = layout(&c, "AAAA BBBB CCCC DDDD EEEE FFFF GGGG");
        assert!(pages[0].lines.len() >= 2);
        for line in &pages[0].lines {
            assert!(measure(&c, line) <= BOX_INNER_W, "line overflowed: {line}");
            assert!(!line.starts_with(' '), "leading space: {line:?}");
        }
        // No word was split.
        let rejoined = pages[0].lines.join(" ");
        assert!(rejoined.contains("AAAA") && rejoined.contains("GGGG"));
    }

    #[test]
    fn an_overlong_word_is_broken_rather_than_overflowing() {
        let c = font();
        let long = "X".repeat(100);
        let pages = layout(&c, &long);
        for p in &pages {
            for line in &p.lines {
                assert!(measure(&c, line) <= BOX_INNER_W);
            }
        }
        let total: usize = pages.iter().flat_map(|p| p.lines.iter()).map(|l| l.len()).sum();
        assert_eq!(total, 100, "no characters lost");
    }

    #[test]
    fn form_feed_starts_a_new_page() {
        let c = font();
        let pages = layout(&c, "PAGE ONE\u{0c}PAGE TWO");
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].lines, alloc::vec!["PAGE ONE"]);
        assert_eq!(pages[1].lines, alloc::vec!["PAGE TWO"]);
    }

    #[test]
    fn newline_breaks_a_line_within_a_page() {
        let c = font();
        let pages = layout(&c, "ONE\nTWO");
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].lines, alloc::vec!["ONE", "TWO"]);
    }

    #[test]
    fn a_full_page_rolls_over() {
        let c = font();
        let pages = layout(&c, "L1\nL2\nL3\nL4");
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].lines.len(), LINES);
        assert_eq!(pages[1].lines, alloc::vec!["L4"]);
    }

    #[test]
    fn the_typewriter_reveals_then_waits_for_a() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        let h = t.show(&c, "HI");
        assert!(t.active());
        assert_eq!(t.revealed(), 0);
        // Two characters at TYPE_DELAY frames apart.
        for _ in 0..(2 * (TYPE_DELAY as usize + 1)) {
            t.tick(0, &mut ev);
        }
        assert_eq!(t.revealed(), 2);
        assert!(t.page_done);
        assert!(ev.is_empty(), "the box waits for A before closing");
        t.tick(spec::btn::A, &mut ev);
        assert!(!t.active());
        let done = ev.find(spec::event::TEXT_DONE).copied().expect("textDone");
        assert_eq!(done.b, h);
    }

    #[test]
    fn a_press_fast_forwards_the_reveal_without_skipping() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        t.show(&c, "A LONGER LINE OF DIALOGUE");
        t.tick(spec::btn::A, &mut ev);
        assert!(t.page_done, "the whole page is revealed");
        assert!(t.active(), "but the box is still open");
        assert!(ev.is_empty());
    }

    #[test]
    fn paging_walks_every_page_before_closing() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        t.show(&c, "ONE\u{0c}TWO\u{0c}THREE");
        for expected in ["ONE", "TWO", "THREE"] {
            t.tick(spec::btn::A, &mut ev); // fast-forward
            assert_eq!(t.current().unwrap().lines[0], expected);
            assert!(t.active());
            t.tick(spec::btn::A, &mut ev); // advance
        }
        assert!(!t.active());
        assert_eq!(ev.peek().iter().filter(|e| e.kind == spec::event::TEXT_DONE).count(), 1);
    }

    #[test]
    fn choices_report_the_selected_index() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        let h = t.show_choice(&c, "WELL?", &["YES", "NO"]);
        t.tick(spec::btn::A, &mut ev); // reveal
        assert!(t.choice().is_some());
        t.tick(spec::btn::DOWN, &mut ev);
        assert_eq!(t.choice().unwrap().cursor, 1);
        t.tick(spec::btn::A, &mut ev);
        let done = ev.find(spec::event::CHOICE_DONE).copied().expect("choiceDone");
        assert_eq!((done.b, done.c), (h, 1));
        assert!(!t.active());
    }

    #[test]
    fn b_cancels_a_choice_to_the_last_option() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        t.show_choice(&c, "WELL?", &["YES", "NO"]);
        t.tick(spec::btn::A, &mut ev);
        t.tick(spec::btn::B, &mut ev);
        assert_eq!(ev.find(spec::event::CHOICE_DONE).unwrap().c, 1);
    }

    #[test]
    fn cursor_wraps_both_ways() {
        let c = font();
        let mut t = TextBox::new();
        let mut ev = EventQueue::new();
        t.show_choice(&c, "?", &["A", "B", "C"]);
        t.tick(spec::btn::A, &mut ev);
        t.tick(spec::btn::UP, &mut ev);
        assert_eq!(t.choice().unwrap().cursor, 2);
        t.tick(spec::btn::DOWN, &mut ev);
        assert_eq!(t.choice().unwrap().cursor, 0);
    }

    #[test]
    fn handles_are_unique_per_box() {
        let c = font();
        let mut t = TextBox::new();
        let a = t.show(&c, "ONE");
        let b = t.show(&c, "TWO");
        assert_ne!(a, b);
        assert!(a > 0 && b > 0);
    }

    #[test]
    fn empty_text_does_not_open_a_box() {
        let c = font();
        let mut t = TextBox::new();
        t.show(&c, "");
        assert!(!t.active());
    }

    #[test]
    fn numbers_pad_to_width() {
        assert_eq!(pad_num(7, 3), "  7");
        assert_eq!(pad_num(1234, 3), "1234");
    }
}
