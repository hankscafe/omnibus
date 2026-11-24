//! Folder walks (#282). jwalk reads directories on rayon's shared pool by default, and two things go
//! wrong there:
//! - When the pool is too busy to start a walk within jwalk's 1 s (a conversion's page jobs can keep
//!   every thread busy), jwalk gives back a single "thread-pool busy" error and no entries. Every
//!   `.flatten()` dropped that error, so the walk looked like an empty folder.
//! - Walks started side by side (the Deep Storage Scan runs up to `scan_workers` at once) run on top of
//!   each other's stacks on the pool's threads.
//!
//! `serial` walks on the calling thread, for walks that already have a blocking thread of their own.
//! `parallel` uses the pool, and walks again on the calling thread when the pool is too busy.
//! Both keep jwalk's defaults otherwise: hidden entries skipped, symlinks not followed.

use std::path::Path;

pub type Entry = jwalk::DirEntry<((), ())>;
pub type Item = Result<Entry, jwalk::Error>;

/// A walk on the calling thread.
pub fn serial(root: &Path) -> impl Iterator<Item = Item> {
    jwalk::WalkDir::new(root).parallelism(jwalk::Parallelism::Serial).into_iter()
}

/// A walk on rayon's shared pool. jwalk reports a pool too busy to start the walk as the walk's only
/// item, so that item is checked first and the folder is walked on this thread instead.
pub fn parallel(root: &Path) -> Box<dyn Iterator<Item = Item> + Send> {
    let mut walk = jwalk::WalkDir::new(root).into_iter().peekable();
    if matches!(walk.peek(), Some(Err(e)) if e.is_busy()) {
        log::warn!(
            "[Walk] The shared worker pool was too busy to walk {} in parallel; walking it on this thread instead.",
            root.display()
        );
        return Box::new(serial(root));
    }
    Box::new(walk)
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    /// Runs `f` on a two-thread rayon pool whose other thread is held, so a walk that needs the pool
    /// can't start within jwalk's 1 s - the state a conversion's page jobs put the shared pool in.
    /// (jwalk spawns onto the pool of the thread that starts the walk.)
    pub(crate) fn busy_pool<R: Send>(f: impl FnOnce() -> R + Send) -> R {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(2).build().unwrap();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (held_tx, held_rx) = mpsc::channel::<()>();
        pool.spawn(move || {
            held_tx.send(()).ok();
            let _ = release_rx.recv_timeout(Duration::from_secs(60));
        });
        held_rx.recv().unwrap();
        let out = pool.install(f);
        drop(release_tx);
        out
    }

    /// A folder tree for walk tests: `root/a.cbz`, `root/sub/b.cbr`, `root/sub/deeper/c.zip`,
    /// `root/sub/notes.txt`, and a hidden `root/.hidden/d.cbz` that walks skip. Sizes 3, 5, 7, 11, 13.
    pub(crate) fn walk_tree() -> PathBuf {
        let root = std::env::temp_dir().join(format!("omnibus_walk_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub").join("deeper")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("a.cbz"), b"aaa").unwrap();
        std::fs::write(root.join("sub").join("b.cbr"), b"bbbbb").unwrap();
        std::fs::write(root.join("sub").join("deeper").join("c.zip"), b"ccccccc").unwrap();
        std::fs::write(root.join("sub").join("notes.txt"), b"nnnnnnnnnnn").unwrap();
        std::fs::write(root.join(".hidden").join("d.cbz"), b"ddddddddddddd").unwrap();
        root
    }

    /// The file names a walk found, sorted.
    pub(crate) fn file_names(paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
        let mut v: Vec<String> = paths.into_iter().filter(|p| p.is_file())
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        v.sort();
        v
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{busy_pool, file_names, walk_tree};
    use super::*;

    fn walked(items: impl Iterator<Item = Item>) -> Vec<String> {
        file_names(items.flatten().map(|e| e.path()))
    }

    const ALL: [&str; 4] = ["a.cbz", "b.cbr", "c.zip", "notes.txt"];

    #[test]
    fn a_serial_walk_lists_every_file_while_the_pool_is_busy() {
        let root = walk_tree();
        let found = busy_pool(|| walked(serial(&root)));
        assert_eq!(found, ALL, "hidden entries skipped, the rest found");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_parallel_walk_lists_every_file_while_the_pool_is_busy() {
        let root = walk_tree();
        let found = busy_pool(|| walked(parallel(&root)));
        assert_eq!(found, ALL, "a busy pool never reads as an empty folder");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_parallel_walk_lists_every_file_on_an_idle_pool() {
        let root = walk_tree();
        assert_eq!(walked(parallel(&root)), ALL);
        assert_eq!(walked(serial(&root)), ALL);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_walk_of_a_missing_folder_still_reports_its_error() {
        let missing = std::env::temp_dir().join(format!("omnibus_walk_missing_{}", uuid::Uuid::new_v4()));
        for items in [busy_pool(|| parallel(&missing).collect::<Vec<_>>()), serial(&missing).collect()] {
            assert_eq!(items.len(), 1, "one error item, then the walk ends");
            let err = items[0].as_ref().unwrap_err();
            assert!(!err.is_busy(), "the folder's own error, not a busy pool: {err}");
        }
    }
}
