#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--data-dir") {
        return Err("expected --data-dir PATH".into());
    }
    let data_dir = PathBuf::from(args.next().ok_or("missing data directory")?);
    #[cfg(target_os = "macos")]
    let _ = notify_rust::set_application("dev.lowcord.app");
    let mut backend = backend::Backend::new(data_dir);
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    // Private parent/child pipes only. EOF shuts the backend down with its parent.
    for line in stdin.lock().lines() {
        let line = line?;
        serde_json::to_writer(&mut stdout, &backend.respond(&line))?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}
