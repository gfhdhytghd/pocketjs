//! The EBOOT's global allocator: one static arena with a first-fit free list.
//!
//! rust-psp's default `SystemAlloc` asks the kernel for a *partition block per
//! allocation*. That is fine for a demo that allocates a dozen times; this core
//! parses a content pak into several thousand `Vec`s and `String`s at boot and
//! would exhaust the kernel object table long before it finished. Same
//! conclusion the 2D runtime reached (docs/DESIGN.md "Memory (the blocker
//! fix)"), reached again here — so this crate carries its own small arena
//! rather than linking the whole 2D host to borrow its one.
//!
//! The arena is a `static mut` in `.bss`, which costs nothing in the EBOOT
//! file (bss is zero-filled at load) and nothing in kernel objects.
//!
//! Design: a singly linked free list of blocks, each with an 8-byte header,
//! first-fit, splitting on allocate and coalescing forward on free. Not the
//! fastest allocator in the world; allocation is a boot-time cost here and the
//! steady-state frame allocates nothing (the draw list and vertex buffers keep
//! their capacity).

use core::alloc::{GlobalAlloc, Layout};
use core::ptr;

/// Arena size. Measured need at boot is ~1.6 MB (a 330 kB pak parsed into
/// registries, plus a 16-byte-aligned copy of every atlas page); 6 MB leaves
/// room for content to grow several times over and still fits comfortably in
/// the PSP's 24 MB of user RAM.
pub const ARENA_BYTES: usize = 6 * 1024 * 1024;

#[repr(C, align(16))]
struct Arena([u8; ARENA_BYTES]);

static mut ARENA: Arena = Arena([0; ARENA_BYTES]);

/// Block header. `size` counts the payload only; blocks are 16-byte aligned so
/// the header is 16 bytes to keep payloads aligned too.
#[repr(C, align(16))]
struct Header {
    size: usize,
    next_free: *mut Header,
    free: bool,
}

const HEADER: usize = core::mem::size_of::<Header>();
const ALIGN: usize = 16;

fn round_up(v: usize, a: usize) -> usize {
    (v + a - 1) & !(a - 1)
}

pub struct ArenaAlloc {
    head: spin::Mutex<*mut Header>,
}

// The PSP EBOOT runs the guest on a single worker thread, but interrupts and
// the audio callback can allocate; the spin lock keeps that honest.
unsafe impl Sync for ArenaAlloc {}
unsafe impl Send for ArenaAlloc {}

impl ArenaAlloc {
    pub const fn new() -> Self {
        ArenaAlloc { head: spin::Mutex::new(ptr::null_mut()) }
    }

    /// Lay the whole arena out as one free block. Idempotent.
    unsafe fn init(&self) -> *mut Header {
        let mut head = self.head.lock();
        if !(*head).is_null() {
            return *head;
        }
        let base = ptr::addr_of_mut!(ARENA) as *mut u8;
        let h = base as *mut Header;
        (*h).size = ARENA_BYTES - HEADER;
        (*h).next_free = ptr::null_mut();
        (*h).free = true;
        *head = h;
        h
    }

    /// Bytes still free, for the boot-time stats line.
    pub fn free_bytes(&self) -> usize {
        unsafe {
            let mut total = 0;
            let mut cur = *self.head.lock();
            while !cur.is_null() {
                if (*cur).free {
                    total += (*cur).size;
                }
                cur = (*cur).next_free;
            }
            total
        }
    }
}

unsafe impl GlobalAlloc for ArenaAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let want = round_up(layout.size().max(1), ALIGN).max(layout.align());
        self.init();
        let head = self.head.lock();
        let mut cur = *head;
        while !cur.is_null() {
            if (*cur).free && (*cur).size >= want {
                // Split when the tail is big enough to be worth a header.
                if (*cur).size >= want + HEADER + ALIGN {
                    let next = (cur as *mut u8).add(HEADER + want) as *mut Header;
                    (*next).size = (*cur).size - want - HEADER;
                    (*next).next_free = (*cur).next_free;
                    (*next).free = true;
                    (*cur).size = want;
                    (*cur).next_free = next;
                }
                (*cur).free = false;
                return (cur as *mut u8).add(HEADER);
            }
            cur = (*cur).next_free;
        }
        // Out of arena. Returning null makes Rust call the alloc error handler,
        // which halts with a message rather than corrupting memory.
        ptr::null_mut()
    }

    unsafe fn dealloc(&self, p: *mut u8, _layout: Layout) {
        if p.is_null() {
            return;
        }
        let h = p.sub(HEADER) as *mut Header;
        let _guard = self.head.lock();
        (*h).free = true;
        // Coalesce forward as far as the run of free neighbours goes, so a
        // long-lived pattern of grow-and-free (every `Vec` push past capacity)
        // does not shred the arena into unusable slivers.
        loop {
            let next = (*h).next_free;
            if next.is_null() || !(*next).free {
                break;
            }
            let adjacent = (h as *mut u8).add(HEADER + (*h).size) as *mut Header == next;
            if !adjacent {
                break;
            }
            (*h).size += HEADER + (*next).size;
            (*h).next_free = (*next).next_free;
        }
    }
}

/// A minimal spin lock — `spin` the crate is not vendored, and this needs
/// exactly one primitive.
mod spin {
    use core::cell::UnsafeCell;
    use core::ops::{Deref, DerefMut};
    use core::sync::atomic::{AtomicBool, Ordering};

    pub struct Mutex<T> {
        locked: AtomicBool,
        value: UnsafeCell<T>,
    }

    impl<T> Mutex<T> {
        pub const fn new(value: T) -> Self {
            Mutex { locked: AtomicBool::new(false), value: UnsafeCell::new(value) }
        }

        pub fn lock(&self) -> Guard<'_, T> {
            while self
                .locked
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                core::hint::spin_loop();
            }
            Guard { lock: self }
        }
    }

    pub struct Guard<'a, T> {
        lock: &'a Mutex<T>,
    }

    impl<T> Deref for Guard<'_, T> {
        type Target = T;
        fn deref(&self) -> &T {
            unsafe { &*self.lock.value.get() }
        }
    }

    impl<T> DerefMut for Guard<'_, T> {
        fn deref_mut(&mut self) -> &mut T {
            unsafe { &mut *self.lock.value.get() }
        }
    }

    impl<T> Drop for Guard<'_, T> {
        fn drop(&mut self) {
            self.lock.locked.store(false, Ordering::Release);
        }
    }
}
