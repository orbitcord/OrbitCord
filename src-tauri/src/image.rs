//! Lossless metadata filtering. Pixel data is never decoded or re-encoded.
use serde_json::{json, Value};
use std::io::{self, Read, Write};
const MAX: usize = 64 * 1024 * 1024;
const BAD: &str = "Malformed image";
type Result<T> = std::result::Result<T, &'static str>;
fn slice(b: &[u8], at: usize, n: usize) -> Result<&[u8]> {
    b.get(at..at.checked_add(n).ok_or(BAD)?).ok_or(BAD)
}
fn le(b: &[u8], at: usize) -> Result<usize> {
    Ok(u32::from_le_bytes(slice(b, at, 4)?.try_into().unwrap()) as usize)
}
fn be(b: &[u8], at: usize) -> Result<usize> {
    Ok(u32::from_be_bytes(slice(b, at, 4)?.try_into().unwrap()) as usize)
}
fn orientation(b: &[u8]) -> u16 {
    let read = || -> Option<u16> {
        let little = b.starts_with(b"II");
        if !little && !b.starts_with(b"MM") {
            return None;
        }
        let short = |at| -> Option<u16> {
            let v = b.get(at..at + 2)?.try_into().ok()?;
            Some(if little {
                u16::from_le_bytes(v)
            } else {
                u16::from_be_bytes(v)
            })
        };
        let long = |at| -> Option<usize> {
            let v = b.get(at..at + 4)?.try_into().ok()?;
            Some(if little {
                u32::from_le_bytes(v)
            } else {
                u32::from_be_bytes(v)
            } as usize)
        };
        if short(2)? != 42 {
            return None;
        }
        let offset = long(4)?;
        let count = short(offset)? as usize;
        if count > 4096 || offset + 2 + count * 12 > b.len() {
            return None;
        }
        for i in 0..count {
            let at = offset + 2 + i * 12;
            if short(at)? == 0x112 && short(at + 2)? == 3 && long(at + 4)? == 1 {
                return short(at + 8).filter(|v| (1..=8).contains(v));
            }
        }
        None
    };
    read().unwrap_or(1)
}
fn tiff(value: u16) -> Vec<u8> {
    let mut out = vec![
        73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
    ];
    out[18..20].copy_from_slice(&value.to_le_bytes());
    out
}
fn crc32(b: &[u8]) -> u32 {
    // A table keeps each byte bounded to one lookup, matching the JS algorithm.
    const TABLE: [u32; 256] = {
        let mut table = [0; 256];
        let mut i = 0;
        while i < 256 {
            let mut v = i as u32;
            let mut bit = 0;
            while bit < 8 {
                v = (v >> 1) ^ if v & 1 != 0 { 0xedb88320 } else { 0 };
                bit += 1;
            }
            table[i] = v;
            i += 1;
        }
        table
    };
    let mut crc = !0u32;
    for &v in b {
        crc = (crc >> 8) ^ TABLE[((crc ^ v as u32) & 255) as usize];
    }
    !crc
}
fn jpeg(b: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&b[..2]);
    let mut at = 2;
    while at < b.len() {
        let start = at;
        if b[at] != 255 {
            return Err(BAD);
        }
        at += 1;
        while b.get(at) == Some(&255) {
            at += 1;
        }
        let marker = *b.get(at).ok_or(BAD)?;
        at += 1;
        if marker == 0xd9 {
            out.extend_from_slice(&[255, marker]);
            return Ok(out);
        }
        if marker == 1 || (0xd0..=0xd7).contains(&marker) {
            out.extend_from_slice(&b[start..at]);
            continue;
        }
        let length = u16::from_be_bytes(slice(b, at, 2)?.try_into().unwrap()) as usize;
        if length < 2 {
            return Err(BAD);
        }
        let payload = slice(b, at + 2, length - 2)?;
        let end = at + length;
        if marker == 0xe1 && payload.starts_with(b"Exif\0\0") {
            let value = orientation(&payload[6..]);
            if value != 1 {
                out.extend_from_slice(&[255, 0xe1, 0, 34]);
                out.extend_from_slice(b"Exif\0\0");
                out.extend(tiff(value));
            }
        } else if marker == 0xe0 {
            if payload.len() >= 14 && payload.starts_with(b"JFIF\0") {
                out.extend_from_slice(&[255, 0xe0, 0, 16]);
                out.extend_from_slice(&payload[..12]);
                out.extend_from_slice(&[0, 0]);
            }
        } else if marker == 0xe2 {
            if payload.starts_with(b"ICC_PROFILE\0") {
                out.extend_from_slice(&b[start..end]);
            }
        } else if ![0xe1, 0xed, 0xfe].contains(&marker)
            && (!(0xe3..=0xef).contains(&marker) || marker == 0xee && payload.starts_with(b"Adobe"))
        {
            out.extend_from_slice(&b[start..end]);
        }
        at = end;
        if marker == 0xda {
            let entropy = at;
            while at < b.len() {
                if b[at] != 255 {
                    at += 1;
                    continue;
                }
                let mut next = at + 1;
                while b.get(next) == Some(&255) {
                    next += 1;
                }
                if b.get(next)
                    .is_some_and(|v| *v == 0 || (0xd0..=0xd7).contains(v))
                {
                    at = next + 1;
                    continue;
                }
                break;
            }
            out.extend_from_slice(&b[entropy..at]);
        }
    }
    Err(BAD)
}
fn png(b: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(&b[..8]);
    let mut at = 8;
    let mut image = false;
    let mut first = true;
    while at + 12 <= b.len() {
        let length = be(b, at)?;
        let chunk = slice(b, at, length + 12)?;
        let kind = &chunk[4..8];
        if first && (kind != b"IHDR" || length != 13) {
            return Err(BAD);
        }
        first = false;
        if be(chunk, chunk.len() - 4)? as u32 != crc32(&chunk[4..chunk.len() - 4]) {
            return Err(BAD);
        }
        if kind == b"eXIf" {
            let value = orientation(&chunk[8..chunk.len() - 4]);
            if value != 1 {
                let payload = tiff(value);
                out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
                let start = out.len();
                out.extend_from_slice(b"eXIf");
                out.extend(payload);
                let crc = crc32(&out[start..]);
                out.extend_from_slice(&crc.to_be_bytes());
            }
        } else if [
            b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA", b"iCCP", b"sBIT",
            b"sRGB", b"cICP", b"mDCV", b"cLLI", b"acTL", b"fcTL", b"fdAT",
        ]
        .iter()
        .any(|v| kind == *v)
        {
            out.extend_from_slice(chunk);
        } else if !kind[0].is_ascii_lowercase() {
            return Err(BAD);
        }
        if kind == b"IDAT" {
            image = true;
        }
        if kind == b"IEND" {
            return if image && length == 0 {
                Ok(out)
            } else {
                Err(BAD)
            };
        }
        at += chunk.len();
    }
    Err(BAD)
}
fn webp(b: &[u8]) -> Result<Vec<u8>> {
    if le(b, 4)? + 8 != b.len() {
        return Err(BAD);
    }
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(slice(b, 0, 12)?);
    let mut at = 12;
    let mut image = false;
    let mut extended = None;
    while at + 8 <= b.len() {
        let kind = slice(b, at, 4)?;
        let size = le(b, at + 4)?;
        let chunk = slice(b, at, 8 + size + (size & 1))?;
        if kind == b"VP8X" {
            if size != 10 {
                return Err(BAD);
            }
            extended = Some(out.len() + 8);
            out.extend_from_slice(chunk);
            out[extended.unwrap()] &= !0x0c;
        } else if kind == b"EXIF" {
            let payload = &chunk[8..8 + size];
            let prefix = payload.starts_with(b"Exif\0\0");
            let value = orientation(if prefix { &payload[6..] } else { payload });
            if value != 1 {
                let flag = extended.ok_or(BAD)?;
                let mut minimal = Vec::new();
                if prefix {
                    minimal.extend_from_slice(b"Exif\0\0");
                }
                minimal.extend(tiff(value));
                out.extend_from_slice(b"EXIF");
                out.extend_from_slice(&(minimal.len() as u32).to_le_bytes());
                out.extend_from_slice(&minimal);
                if minimal.len() & 1 != 0 {
                    out.push(0);
                }
                out[flag] |= 8;
            }
        } else if [b"VP8 ", b"VP8L", b"ALPH", b"ICCP", b"ANIM", b"ANMF"]
            .iter()
            .any(|v| kind == *v)
        {
            out.extend_from_slice(chunk);
        }
        if [b"VP8 ", b"VP8L", b"ANMF"].iter().any(|v| kind == *v) {
            image = true;
        }
        at += chunk.len();
    }
    if at != b.len() || !image {
        return Err(BAD);
    }
    let length = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&length.to_le_bytes());
    Ok(out)
}
fn gif(b: &[u8]) -> Result<Vec<u8>> {
    slice(b, 0, 14)?;
    let mut at = 13
        + if b[10] & 128 != 0 {
            3 * (1usize << ((b[10] & 7) + 1))
        } else {
            0
        };
    let mut out = Vec::with_capacity(b.len());
    out.extend_from_slice(slice(b, 0, at)?);
    let mut image = false;
    fn blocks(b: &[u8], at: &mut usize) -> Result<()> {
        loop {
            let length = *b.get(*at).ok_or(BAD)? as usize;
            *at += 1;
            if length == 0 {
                return Ok(());
            }
            slice(b, *at, length)?;
            *at += length;
        }
    }
    while at < b.len() {
        let start = at;
        let kind = b[at];
        at += 1;
        if kind == 0x3b {
            if !image {
                return Err(BAD);
            }
            out.push(kind);
            return Ok(out);
        }
        if kind == 0x2c {
            let packed = slice(b, at, 9)?[8];
            at += 9;
            if packed & 128 != 0 {
                at += 3 * (1usize << ((packed & 7) + 1));
            }
            slice(b, at, 1)?;
            at += 1;
            blocks(b, &mut at)?;
            out.extend_from_slice(&b[start..at]);
            image = true;
        } else if kind == 0x21 {
            let label = *b.get(at).ok_or(BAD)?;
            at += 1;
            let app = if label == 255 {
                b.get(at + 1..at + 12).unwrap_or_default()
            } else {
                &[]
            };
            blocks(b, &mut at)?;
            if label == 0xf9
                || label == 255 && [b"NETSCAPE2.0", b"ANIMEXTS1.0"].iter().any(|v| app == *v)
            {
                out.extend_from_slice(&b[start..at]);
            } else if label == 1 {
                return Err(BAD);
            }
        } else {
            return Err(BAD);
        }
    }
    Err(BAD)
}
pub fn sanitize(b: &[u8]) -> (Value, Vec<u8>) {
    if b.len() > MAX {
        return (
            json!({"status":"unsupported","reason":"Images up to 64 MiB are supported."}),
            vec![],
        );
    }
    let (kind, output) = if b.starts_with(&[255, 216]) {
        ("jpeg", jpeg(b))
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("png", png(b))
    } else if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        ("webp", webp(b))
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        ("gif", gif(b))
    } else {
        return (
            json!({"status":"unsupported","reason":"Supported: JPEG, PNG/APNG, WebP and GIF. Other files are unchanged."}),
            vec![],
        );
    };
    match output {
        Ok(out) => (
            json!({"status":"processed","type":format!("image/{kind}"),"changed":out != b,"note":"EXIF, XMP, IPTC and comments removed where present. Orientation, animation and color profiles retained; profiles and visible pixels are not scrubbed."}),
            out,
        ),
        Err(_) => (
            json!({"status":"uninspectable","reason":"Could not safely parse this image. The original was not changed."}),
            vec![],
        ),
    }
}
/// Dedicated one-job process: raw input, length-prefixed JSON metadata, raw output.
/// Heavy media work cannot block the window-state/notification command loop.
pub fn run() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin().take((MAX + 1) as u64).read_to_end(&mut input)?;
    let (metadata, bytes) = sanitize(&input);
    let metadata = serde_json::to_vec(&metadata)?;
    let mut out = io::stdout().lock();
    out.write_all(&(metadata.len() as u32).to_le_bytes())?;
    out.write_all(&metadata)?;
    out.write_all(&bytes)?;
    Ok(())
}
