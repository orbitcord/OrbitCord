//! Fragmented MP4 remuxing. Only headers are resident; media copies use 1 MiB.
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
#[derive(Clone)]
struct BoxInfo {
    kind: [u8; 4],
    start: usize,
    end: usize,
    header: usize,
}
fn u32at(b: &[u8], p: usize) -> Result<u32> {
    Ok(u32::from_be_bytes(
        b.get(p..p + 4).ok_or("truncated MP4")?.try_into()?,
    ))
}
fn u64at(b: &[u8], p: usize) -> Result<u64> {
    Ok(u64::from_be_bytes(
        b.get(p..p + 8).ok_or("truncated MP4")?.try_into()?,
    ))
}
fn set32(b: &mut [u8], p: usize, v: u32) -> Result<()> {
    b.get_mut(p..p + 4)
        .ok_or("truncated MP4")?
        .copy_from_slice(&v.to_be_bytes());
    Ok(())
}
fn boxes(b: &[u8], start: usize, end: usize) -> Result<Vec<BoxInfo>> {
    let mut out = vec![];
    let mut p = start;
    while p + 8 <= end {
        let n = u32at(b, p)?;
        let h = if n == 1 { 16 } else { 8 };
        let size = match n {
            0 => end - p,
            1 => usize::try_from(u64at(b, p + 8)?)?,
            _ => n as usize,
        };
        let stop = p.checked_add(size).ok_or("size overflow")?;
        if size < h || stop > end {
            return Err("malformed MP4 box".into());
        }
        out.push(BoxInfo {
            kind: b[p + 4..p + 8].try_into()?,
            start: p,
            end: stop,
            header: h,
        });
        p = stop;
    }
    Ok(out)
}
fn children(b: &[u8], item: &BoxInfo) -> Result<Vec<BoxInfo>> {
    boxes(b, item.start + item.header, item.end)
}
fn child(b: &[u8], item: &BoxInfo, kind: &[u8; 4]) -> Result<BoxInfo> {
    children(b, item)?
        .into_iter()
        .find(|x| &x.kind == kind)
        .ok_or_else(|| "missing MP4 box".into())
}
fn make(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
    let len = 8 + parts.iter().map(|x| x.len()).sum::<usize>();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&(len as u32).to_be_bytes());
    out.extend_from_slice(kind);
    for p in parts {
        out.extend_from_slice(p);
    }
    out
}
fn read(file: &mut File, p: usize, n: usize) -> Result<Vec<u8>> {
    if n > 16 * 1024 * 1024 {
        return Err("oversized MP4 metadata".into());
    }
    file.seek(SeekFrom::Start(p as u64))?;
    let mut b = vec![0; n];
    file.read_exact(&mut b)?;
    Ok(b)
}
fn disk_boxes(file: &mut File) -> Result<Vec<BoxInfo>> {
    let end = usize::try_from(file.metadata()?.len())?;
    let mut p = 0;
    let mut out = vec![];
    while p + 8 <= end {
        let b = read(file, p, 16.min(end - p))?;
        let n = u32at(&b, 0)?;
        let h = if n == 1 { 16 } else { 8 };
        let size = match n {
            0 => end - p,
            1 => usize::try_from(u64at(&b, 8)?)?,
            _ => n as usize,
        };
        let stop = p.checked_add(size).ok_or("overflow")?;
        if size < h || stop > end {
            return Err("malformed MP4 box".into());
        }
        out.push(BoxInfo {
            kind: b[4..8].try_into()?,
            start: p,
            end: stop,
            header: h,
        });
        p = stop;
    }
    Ok(out)
}
struct Fragment {
    moof: BoxInfo,
    mdat: BoxInfo,
    tfhd: usize,
    time: f64,
}
struct Movie {
    file: File,
    buffer: Vec<u8>,
    ftyp: BoxInfo,
    moov: BoxInfo,
    trak: BoxInfo,
    trex: BoxInfo,
    timescale: u32,
    duration: u64,
    fragments: Vec<Fragment>,
}
fn parse(path: &str) -> Result<Movie> {
    let mut file = File::open(path)?;
    let top = disk_boxes(&mut file)?;
    let ftyp = top.iter().find(|x| &x.kind == b"ftyp").ok_or("not MP4")?;
    let moov = top.iter().find(|x| &x.kind == b"moov").ok_or("not MP4")?;
    let mut buffer = read(&mut file, ftyp.start, ftyp.end - ftyp.start)?;
    buffer.extend(read(&mut file, moov.start, moov.end - moov.start)?);
    let head = boxes(&buffer, 0, buffer.len())?;
    let ftyp = head.iter().find(|x| &x.kind == b"ftyp").unwrap().clone();
    let moov = head.iter().find(|x| &x.kind == b"moov").unwrap().clone();
    let traks: Vec<_> = children(&buffer, &moov)?
        .into_iter()
        .filter(|x| &x.kind == b"trak")
        .collect();
    if traks.len() != 1 {
        return Err("expected one track".into());
    }
    let trak = traks[0].clone();
    let mdia = child(&buffer, &trak, b"mdia")?;
    let mdhd = child(&buffer, &mdia, b"mdhd")?;
    let mvex = child(&buffer, &moov, b"mvex")?;
    let trex = child(&buffer, &mvex, b"trex")?;
    let timescale = u32at(
        &buffer,
        mdhd.start + if buffer[mdhd.start + 8] == 1 { 28 } else { 20 },
    )?;
    if timescale == 0 {
        return Err("invalid timescale".into());
    }
    let default = u32at(&buffer, trex.start + 20)? as u64;
    let mut duration = 0;
    let mut fragments = vec![];
    for (i, moof) in top.iter().enumerate().filter(|(_, x)| &x.kind == b"moof") {
        let mdat = top
            .get(i + 1)
            .filter(|x| &x.kind == b"mdat")
            .ok_or("fragment without data")?
            .clone();
        let b = read(&mut file, moof.start, moof.end - moof.start)?;
        let local = boxes(&b, 0, b.len())?.remove(0);
        let trafs: Vec<_> = children(&b, &local)?
            .into_iter()
            .filter(|x| &x.kind == b"traf")
            .collect();
        if trafs.len() != 1 {
            return Err("expected one fragment track".into());
        }
        let traf = &trafs[0];
        let tfhd = child(&b, traf, b"tfhd")?;
        let tfdt = child(&b, traf, b"tfdt")?;
        let flags = u32at(&b, tfhd.start + 8)? & 0xffffff;
        if flags & 1 != 0 {
            return Err("absolute offsets unsupported".into());
        }
        let field = tfhd.start + 16 + if flags & 2 != 0 { 4 } else { 0 };
        let sample = if flags & 8 != 0 {
            u32at(&b, field)? as u64
        } else {
            default
        };
        let time = if b[tfdt.start + 8] == 1 {
            u64at(&b, tfdt.start + 12)?
        } else {
            u32at(&b, tfdt.start + 12)? as u64
        };
        let mut span = 0u64;
        for trun in children(&b, traf)?.iter().filter(|x| &x.kind == b"trun") {
            let flags = u32at(&b, trun.start + 8)? & 0xffffff;
            let count = u32at(&b, trun.start + 12)? as usize;
            let mut cursor = trun.start
                + 16
                + if flags & 1 != 0 { 4 } else { 0 }
                + if flags & 4 != 0 { 4 } else { 0 };
            let stride = [0x100, 0x200, 0x400, 0x800]
                .iter()
                .filter(|v| flags & **v != 0)
                .count()
                * 4;
            if count > 10_000_000
                || cursor
                    .checked_add(count * stride)
                    .is_none_or(|end| end > trun.end)
            {
                return Err("invalid sample table".into());
            }
            if stride == 0 {
                span = span
                    .checked_add(
                        sample
                            .checked_mul(count as u64)
                            .ok_or("duration overflow")?,
                    )
                    .ok_or("duration overflow")?;
            } else {
                for _ in 0..count {
                    span = span
                        .checked_add(if flags & 0x100 != 0 {
                            u32at(&b, cursor)? as u64
                        } else {
                            sample
                        })
                        .ok_or("duration overflow")?;
                    cursor += stride;
                }
            }
        }
        duration = duration.max(time.checked_add(span).ok_or("duration overflow")?);
        fragments.push(Fragment {
            moof: moof.clone(),
            mdat,
            tfhd: tfhd.start,
            time: time as f64 / timescale as f64,
        });
    }
    if fragments.is_empty() {
        return Err("no media fragments".into());
    }
    Ok(Movie {
        file,
        buffer,
        ftyp,
        moov,
        trak,
        trex,
        timescale,
        duration,
        fragments,
    })
}
fn duration(b: &mut [u8], item: &BoxInfo, value: f64) -> Result<()> {
    let version = *b.get(item.start + 8).ok_or("version")?;
    let offset = item.start
        + 12
        + if version == 1 { 16 } else { 8 }
        + if &item.kind == b"tkhd" {
            if version == 1 {
                8
            } else {
                4
            }
        } else {
            4
        };
    if version == 1 {
        b.get_mut(offset..offset + 8)
            .ok_or("duration")?
            .copy_from_slice(&(value.round() as u64).to_be_bytes());
    } else {
        set32(b, offset, value.round().min(u32::MAX as f64) as u32)?;
    }
    Ok(())
}
fn track(file: &Movie, id: u32, scale: u32) -> Result<Vec<u8>> {
    let mut b = file.buffer[file.trak.start..file.trak.end].to_vec();
    let trak = BoxInfo {
        kind: *b"trak",
        start: 0,
        end: b.len(),
        header: 8,
    };
    let tkhd = child(&b, &trak, b"tkhd")?;
    let mdia = child(&b, &trak, b"mdia")?;
    let mdhd = child(&b, &mdia, b"mdhd")?;
    let offset = tkhd.start + if b[tkhd.start + 8] == 1 { 28 } else { 20 };
    set32(&mut b, offset, id)?;
    duration(
        &mut b,
        &tkhd,
        file.duration as f64 / file.timescale as f64 * scale as f64,
    )?;
    duration(&mut b, &mdhd, file.duration as f64)?;
    Ok(b)
}
pub fn mux(video: &str, audio: &str, path: &str) -> Result<()> {
    let mut video = parse(video)?;
    let mut audio = parse(audio)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(path)?;
    let result = (|| -> Result<()> {
        let mvhd_box = child(&video.buffer, &video.moov, b"mvhd")?;
        let mut mvhd = video.buffer[mvhd_box.start..mvhd_box.end].to_vec();
        let scale = u32at(&mvhd, if mvhd[8] == 1 { 28 } else { 20 })?;
        let seconds = (video.duration as f64 / video.timescale as f64)
            .max(audio.duration as f64 / audio.timescale as f64);
        let item = BoxInfo {
            kind: *b"mvhd",
            start: 0,
            end: mvhd.len(),
            header: 8,
        };
        duration(&mut mvhd, &item, seconds * scale as f64)?;
        let end = mvhd.len();
        set32(&mut mvhd, end - 4, 3)?;
        let mut vt = video.buffer[video.trex.start..video.trex.end].to_vec();
        set32(&mut vt, 12, 1)?;
        let mut at = audio.buffer[audio.trex.start..audio.trex.end].to_vec();
        set32(&mut at, 12, 2)?;
        let mut mehd = vec![0; 8];
        set32(&mut mehd, 4, (seconds * scale as f64).round() as u32)?;
        let mehd = make(b"mehd", &[&mehd]);
        let mvex = make(b"mvex", &[&mehd, &vt, &at]);
        let vt = track(&video, 1, scale)?;
        let at = track(&audio, 2, scale)?;
        output.write_all(&video.buffer[video.ftyp.start..video.ftyp.end])?;
        output.write_all(&make(b"moov", &[&mvhd, &vt, &at, &mvex]))?;
        let mut order: Vec<_> = video
            .fragments
            .iter()
            .enumerate()
            .map(|(i, f)| (f.time, 1u32, i))
            .chain(
                audio
                    .fragments
                    .iter()
                    .enumerate()
                    .map(|(i, f)| (f.time, 2u32, i)),
            )
            .collect();
        order.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        let mut chunk = vec![0; 1024 * 1024];
        for (sequence, (_, id, index)) in order.iter().enumerate() {
            let movie = if *id == 1 { &mut video } else { &mut audio };
            let f = &movie.fragments[*index];
            let mut moof = read(&mut movie.file, f.moof.start, f.moof.end - f.moof.start)?;
            let local = boxes(&moof, 0, moof.len())?.remove(0);
            if let Ok(mfhd) = child(&moof, &local, b"mfhd") {
                set32(&mut moof, mfhd.start + 12, sequence as u32 + 1)?;
            }
            set32(&mut moof, f.tfhd + 12, *id)?;
            output.write_all(&moof)?;
            movie.file.seek(SeekFrom::Start(f.mdat.start as u64))?;
            let mut remaining = f.mdat.end - f.mdat.start;
            while remaining > 0 {
                let n = remaining.min(chunk.len());
                movie.file.read_exact(&mut chunk[..n])?;
                output.write_all(&chunk[..n])?;
                remaining -= n;
            }
        }
        Ok(())
    })();
    drop(output);
    if result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}
