//! Bounded format / ZIP directory inspection, never extracting archive paths.
use serde::Serialize;
use serde_json::{json, Value};
#[derive(Serialize)]
struct Entry {
    name: String,
    size: usize,
    compressed: usize,
    method: usize,
    offset: usize,
    encrypted: bool,
    directory: bool,
}
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn u16at(b: &[u8], p: usize) -> Result<usize> {
    Ok(u16::from_le_bytes(b.get(p..p + 2).ok_or("truncated ZIP")?.try_into()?) as usize)
}
fn u32at(b: &[u8], p: usize) -> Result<usize> {
    Ok(u32::from_le_bytes(b.get(p..p + 4).ok_or("truncated ZIP")?.try_into()?) as usize)
}
fn u64at(b: &[u8], p: usize) -> Result<usize> {
    let n = u64::from_le_bytes(b.get(p..p + 8).ok_or("truncated ZIP64")?.try_into()?);
    if n > 9007199254740991 {
        return Err("ZIP64 exceeds safe range".into());
    }
    Ok(usize::try_from(n)?)
}
const CP437:&str="ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
fn name(b: &[u8], utf8: bool, preview: bool) -> String {
    if utf8 {
        String::from_utf8_lossy(b).into_owned()
    } else if preview {
        b.iter()
            .map(|&v| {
                if v < 128 {
                    v as char
                } else {
                    CP437.chars().nth((v - 128) as usize).unwrap()
                }
            })
            .collect()
    } else {
        b.iter().map(|&v| v as char).collect()
    }
}
fn entries(b: &[u8], count: usize, preview: bool) -> Result<(Vec<Entry>, bool)> {
    if b.len() > 8 * 1024 * 1024 {
        return Err("directory limit".into());
    }
    let mut at = 0;
    let mut out = vec![];
    let cap = if preview { 5000 } else { 10000 };
    while out.len() < count && at + 46 <= b.len() {
        if u32at(b, at)? != 0x02014b50 {
            return Err("corrupt ZIP".into());
        }
        if out.len() >= cap {
            return Ok((out, true));
        }
        let flags = u16at(b, at + 8)?;
        let method = u16at(b, at + 10)?;
        let mut compressed = u32at(b, at + 20)?;
        let mut size = u32at(b, at + 24)?;
        let mut offset = u32at(b, at + 42)?;
        let n = u16at(b, at + 28)?;
        let x = u16at(b, at + 30)?;
        let comment = u16at(b, at + 32)?;
        let name_end = at + 46 + n;
        let extra_end = name_end + x;
        let next = extra_end + comment;
        if next > b.len() {
            return Err("corrupt ZIP".into());
        }
        if preview {
            let mut extra = name_end;
            while extra + 4 <= extra_end {
                let id = u16at(b, extra)?;
                let len = u16at(b, extra + 2)?;
                if extra + 4 + len > extra_end {
                    return Err("corrupt ZIP64 extra".into());
                }
                if id == 1 {
                    let mut p = extra + 4;
                    for field in [&mut size, &mut compressed, &mut offset] {
                        if *field == 0xffffffff {
                            if p + 8 > extra + 4 + len {
                                return Err("corrupt ZIP64 extra".into());
                            }
                            *field = u64at(b, p)?;
                            p += 8;
                        }
                    }
                }
                extra += 4 + len;
            }
        } else if compressed == 0xffffffff || size == 0xffffffff {
            return Err("unsupported ZIP64 inspection".into());
        }
        let name = name(&b[at + 46..name_end], flags & 0x800 != 0, preview);
        let directory = name.ends_with('/');
        out.push(Entry {
            name,
            size,
            compressed,
            method,
            offset,
            encrypted: flags & 1 != 0,
            directory,
        });
        at = next;
    }
    if !preview && (at != b.len() || out.len() != count) {
        return Err("incomplete ZIP directory".into());
    }
    Ok((out, false))
}
pub fn directory(b: &[u8], count: usize) -> Result<Vec<u8>> {
    let (e, t) = entries(b, count, true)?;
    #[derive(Serialize)]
    struct Preview {
        entries: Vec<Entry>,
        truncated: bool,
    }
    Ok(serde_json::to_vec(&Preview {
        entries: e,
        truncated: t,
    })?)
}
pub fn inflate(b: &[u8]) -> Result<Vec<u8>> {
    let mut out = vec![];
    flate2::read::DeflateDecoder::new(b)
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut out)?;
    if out.len() > 2 * 1024 * 1024 {
        return Err("Too large".into());
    }
    Ok(out)
}
fn extension(s: &str) -> String {
    s.rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn matches(s: &str, values: &str) -> bool {
    let Some((_, ext)) = s.rsplit_once('.') else {
        return false;
    };
    values.split('|').any(|x| x.eq_ignore_ascii_case(ext))
}
const DANGEROUS:&str="exe|com|scr|msi|msp|msix|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|jar|app|command|sh|desktop|dmg|pkg|deb|rpm|appimage|pif|cpl|scf|sct|chm|xll|docm|xlsm|pptm|workflow|action";
const ARCHIVE: &str = "zip|zipx|7z|rar|tar|gz|bz2|xz|iso|img|vhd|vhdx";
fn format(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[255, 216]) {
        Some("jpeg")
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some("gif")
    } else if b.starts_with(b"MZ")
        || b.starts_with(b"\x7fELF")
        || [
            &[0xfe, 0xed, 0xfa, 0xce],
            &[0xfe, 0xed, 0xfa, 0xcf],
            &[0xce, 0xfa, 0xed, 0xfe],
            &[0xcf, 0xfa, 0xed, 0xfe],
            &[0xca, 0xfe, 0xba, 0xbe],
        ]
        .iter()
        .any(|v| b.starts_with(*v))
    {
        Some("executable")
    } else if b.starts_with(b"PK\x03\x04") || b.starts_with(b"PK\x05\x06") {
        Some("zip")
    } else if b.starts_with(b"%PDF-") {
        Some("pdf")
    } else if b.get(4..8) == Some(b"ftyp") {
        Some("mp4")
    } else if b.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        Some("webm")
    } else if b.starts_with(b"OggS") {
        Some("ogg")
    } else if b.starts_with(b"ID3")
        || b.first() == Some(&255) && b.get(1).is_some_and(|v| v & 0xe0 == 0xe0)
    {
        Some("mp3")
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WAVE") {
        Some("wav")
    } else if !b.is_empty()
        && !b.iter().any(|&v| v < 9 || v > 13 && v < 32 || v == 127)
        && (0..4.min(b.len())).any(|trim| std::str::from_utf8(&b[..b.len() - trim]).is_ok())
    {
        Some("text")
    } else {
        None
    }
}
fn read(file: &mut File, start: u64, n: usize) -> Result<Vec<u8>> {
    if n > 8 * 1024 * 1024 {
        return Err("range limit".into());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut out = vec![0; n];
    file.read_exact(&mut out)?;
    Ok(out)
}
pub fn inspect(path: &str, filename: &str) -> Result<Value> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let name: String = filename.chars().take(512).collect();
    let mut reasons: Vec<&str> = vec![];
    let mut found = vec![];
    let mut complete = true;
    let mut kind = None;
    if size == 0 {
        return Ok(
            json!({"status":"uninspectable","reasons":["Empty or invalid file."],"entries":[]}),
        );
    }
    let mut add = |r| {
        if !reasons.contains(&r) {
            reasons.push(r);
        }
    };
    if matches(&name, DANGEROUS) {
        add("This file type can run code or install software.");
    } else if matches(&name, "htm|html|xhtml|mht|mhtml|py|pyw") {
        add("This file can run scripts when opened.");
    }
    if name
        .chars()
        .any(|c| ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c))
    {
        add("The filename contains direction-changing characters that can disguise its extension.");
    }
    if matches(&name, DANGEROUS)
        && name.rsplit_once('.').is_some_and(|(stem, _)| {
            matches(stem.trim_end(), "png|jpg|jpeg|gif|pdf|txt|mp4|doc|docx")
        })
    {
        add("A double extension makes this file look like a document or media file.");
    }
    let result = (|| -> Result<()> {
        let header = read(&mut file, 0, size.min(512) as usize)?;
        kind = format(&header);
        if kind == Some("executable") {
            add("The file contains an executable signature.");
        }
        let ext = extension(&name);
        let expected = match ext.as_str() {
            "png" | "apng" => Some("png"),
            "jpg" | "jpeg" => Some("jpeg"),
            "gif" => Some("gif"),
            "webp" => Some("webp"),
            "pdf" => Some("pdf"),
            "zip" => Some("zip"),
            _ => None,
        };
        if expected.is_some() && expected != kind {
            add("The file content does not match its filename extension.");
        }
        if kind == Some("zip") {
            let n = size.min(65557) as usize;
            let tail = read(&mut file, size - n as u64, n)?;
            let mut end = None;
            if n >= 22 {
                for at in (0..=n - 22).rev() {
                    if u32at(&tail, at)? == 0x06054b50 && at + 22 + u16at(&tail, at + 20)? == n {
                        end = Some(at);
                        break;
                    }
                }
            }
            let end = end.ok_or("missing directory")?;
            let count = u16at(&tail, end + 10)?;
            let length = u32at(&tail, end + 12)?;
            let offset = u32at(&tail, end + 16)?;
            if u16at(&tail, end + 4)? != 0
                || u16at(&tail, end + 6)? != 0
                || u16at(&tail, end + 8)? != count
                || count > 10000
                || length > 8 * 1024 * 1024
                || offset as u64 + length as u64 > size - n as u64 + end as u64
            {
                return Err("unsupported directory".into());
            }
            let b = read(&mut file, offset as u64, length)?;
            let (entries, _) = entries(&b, count, false)?;
            for e in entries {
                let entry = e.name.as_str();
                let norm = entry.replace('\\', "/");
                let lower = norm.to_ascii_lowercase();
                if matches(entry, DANGEROUS)
                    || norm
                        .split('/')
                        .any(|p| p.to_ascii_lowercase().ends_with(".app"))
                    || lower == "vbaproject.bin"
                    || lower.ends_with("/vbaproject.bin")
                {
                    add("The archive contains files that can run code.");
                    if found.len() < 50 {
                        found.push(entry.chars().take(300).collect::<String>());
                    }
                }
                if norm.split('/').any(|p| p == "..")
                    || norm.starts_with('/')
                    || norm.as_bytes().get(1) == Some(&b':')
                        && norm.as_bytes()[0].is_ascii_alphabetic()
                {
                    add("The archive contains paths that could escape its extraction folder.");
                }
                if e.encrypted || e.method == 99 {
                    complete = false;
                    add("Encrypted archive contents cannot be inspected.");
                }
                if matches(entry, ARCHIVE) {
                    complete = false;
                    add("Nested archives were not opened.");
                }
                let expanded = e.size as u64;
                let compressed = e.compressed as u64;
                if expanded > 1024 * 1024 * 1024 || expanded > compressed.max(1) * 1000 {
                    add("The archive includes unusually large expanded content.");
                }
            }
        } else if matches(&name, ARCHIVE) {
            complete = false;
            add("This archive format is not supported for content inspection.");
        } else if kind.is_none() {
            complete = false;
            add("This file format could not be identified.");
        }
        Ok(())
    })();
    if result.is_err() {
        complete = false;
        add("Unable to inspect all file contents.");
    }
    let warning = reasons.iter().any(|r| {
        [
            "run code",
            "run scripts",
            "executable",
            "double extension",
            "direction-changing",
            "does not match",
            "escape",
            "unusually large",
        ]
        .iter()
        .any(|s| r.contains(s))
    });
    let mut out = json!({"status":if warning{"warning"}else if complete{"checked"}else{"uninspectable"},"reasons":reasons,"entries":found,"complete":complete,"note":"Local format and ZIP directory checks only. Not an antivirus scan."});
    out["kind"] = json!(kind);
    Ok(out)
}
