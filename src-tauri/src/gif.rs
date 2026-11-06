//! Incremental GIF encoding; only two indexed frames and one palette are held.
use serde_json::Value;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
struct ColorBox {
    list: Vec<usize>,
    count: u64,
    axis: usize,
    score: u64,
}
fn channel(key: usize, axis: usize) -> usize {
    key >> (10 - axis * 5) & 31
}
fn color_box(list: Vec<usize>, hist: &[u64]) -> ColorBox {
    let mut low = [31; 3];
    let mut high = [0; 3];
    let mut count = 0;
    for &key in &list {
        count += hist[key];
        for axis in 0..3 {
            let v = channel(key, axis);
            low[axis] = low[axis].min(v);
            high[axis] = high[axis].max(v);
        }
    }
    let ranges = [high[0] - low[0], high[1] - low[1], high[2] - low[2]];
    let mut axis = 0;
    for i in 1..3 {
        if ranges[i] > ranges[axis] {
            axis = i;
        }
    }
    ColorBox {
        list,
        count,
        axis,
        score: ranges[axis] as u64 * count,
    }
}
fn word(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&(v as u16).to_le_bytes());
}
pub struct Encoder {
    width: usize,
    height: usize,
    fps: f64,
    hist: Vec<u64>,
    table: Vec<u8>,
    length: usize,
    cache: Vec<i16>,
    previous: Option<Vec<u8>>,
    codes: Vec<u16>,
    stamps: Vec<u32>,
    generation: u32,
    started: bool,
    next: usize,
}
impl Encoder {
    pub fn new(args: &Value) -> Result<Self> {
        let width = args["width"].as_u64().ok_or("width")? as usize;
        let height = args["height"].as_u64().ok_or("height")? as usize;
        let fps = args["fps"].as_f64().ok_or("fps")?;
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || width * height > 4 * 1024 * 1024
            || !fps.is_finite()
            || fps <= 0.
            || fps > 60.
        {
            return Err("invalid GIF dimensions or fps".into());
        }
        Ok(Self {
            width,
            height,
            fps,
            hist: vec![0; 32768],
            table: vec![0; 768],
            length: 1,
            cache: vec![-1; 32768],
            previous: None,
            codes: vec![0; 1 << 20],
            stamps: vec![0; 1 << 20],
            generation: 0,
            started: false,
            next: 0,
        })
    }
    pub fn sample(&mut self, rgba: &[u8]) -> Result<()> {
        if self.started || rgba.len() != self.width * self.height * 4 {
            return Err("invalid GIF sample".into());
        }
        for p in rgba.chunks_exact(4) {
            self.hist[((p[0] as usize >> 3) << 10)
                | ((p[1] as usize >> 3) << 5)
                | (p[2] as usize >> 3)] += 1;
        }
        Ok(())
    }
    pub fn start(&mut self) -> Vec<u8> {
        let colors: Vec<_> = (0..32768).filter(|&k| self.hist[k] > 0).collect();
        let mut boxes = if colors.is_empty() {
            vec![]
        } else {
            vec![color_box(colors, &self.hist)]
        };
        while boxes.len() < 255 {
            let mut selected = None;
            for (i, b) in boxes.iter().enumerate() {
                if b.list.len() > 1 && selected.is_none_or(|n: usize| b.score > boxes[n].score) {
                    selected = Some(i);
                }
            }
            let Some(index) = selected else { break };
            let mut b = boxes.remove(index);
            b.list.sort_by_key(|&k| channel(k, b.axis));
            let mut seen = 0;
            let mut cut = 1;
            while cut < b.list.len() - 1 {
                seen += self.hist[b.list[cut - 1]];
                if seen * 2 >= b.count {
                    break;
                }
                cut += 1;
            }
            let right = b.list.split_off(cut);
            boxes.insert(index, color_box(b.list, &self.hist));
            boxes.insert(index + 1, color_box(right, &self.hist));
        }
        for (i, b) in boxes.iter().enumerate() {
            for axis in 0..3 {
                let sum: u64 = b
                    .list
                    .iter()
                    .map(|&k| (channel(k, axis) * 8 + 4) as u64 * self.hist[k])
                    .sum();
                self.table[i * 3 + axis] = (sum as f64 / b.count as f64).round() as u8;
            }
        }
        self.length = boxes.len().max(1);
        self.started = true;
        let mut out = b"GIF89a".to_vec();
        word(&mut out, self.width);
        word(&mut out, self.height);
        out.extend_from_slice(&[0xf7, 0, 0]);
        out.extend_from_slice(&self.table);
        out.extend_from_slice(b"\x21\xff\x0bNETSCAPE2.0\x03\x01\0\0\0");
        out
    }
    fn nearest(&mut self, key: usize) -> u8 {
        if self.cache[key] >= 0 {
            return self.cache[key] as u8;
        }
        let r = ((key >> 10) * 8 + 4) as i32;
        let g = (((key >> 5) & 31) * 8 + 4) as i32;
        let b = ((key & 31) * 8 + 4) as i32;
        let mut best = i32::MAX;
        let mut index = 0;
        for i in 0..self.length {
            let dr = r - self.table[i * 3] as i32;
            let dg = g - self.table[i * 3 + 1] as i32;
            let db = b - self.table[i * 3 + 2] as i32;
            let d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
            if d < best {
                best = d;
                index = i;
            }
        }
        self.cache[key] = index as i16;
        index as u8
    }
    fn lzw(&mut self, pixels: &[u8], out: &mut Vec<u8>) {
        let mut size = 9;
        let mut limit = 511;
        let mut next = 258u16;
        let mut reset = false;
        let mut bits = 0u32;
        let mut count = 0;
        let mut block = Vec::new();
        fn emit(
            code: u16,
            size: &mut u32,
            limit: &mut u16,
            next: u16,
            reset: &mut bool,
            bits: &mut u32,
            count: &mut u32,
            block: &mut Vec<u8>,
        ) {
            *bits |= (code as u32) << *count;
            *count += *size;
            while *count >= 8 {
                block.push(*bits as u8);
                *bits >>= 8;
                *count -= 8;
            }
            if *reset {
                *size = 9;
                *limit = 511;
                *reset = false;
            } else if next > *limit {
                *size += 1;
                *limit = if *size == 12 { 4096 } else { (1 << *size) - 1 };
            }
        }
        self.generation += 1;
        emit(
            256, &mut size, &mut limit, next, &mut reset, &mut bits, &mut count, &mut block,
        );
        let mut prefix = pixels[0] as u16;
        for &pixel in &pixels[1..] {
            let key = ((prefix as usize) << 8) | pixel as usize;
            if self.stamps[key] == self.generation {
                prefix = self.codes[key];
                continue;
            }
            emit(
                prefix, &mut size, &mut limit, next, &mut reset, &mut bits, &mut count, &mut block,
            );
            if next < 4096 {
                self.stamps[key] = self.generation;
                self.codes[key] = next;
                next += 1;
            } else {
                self.generation += 1;
                next = 258;
                reset = true;
                emit(
                    256, &mut size, &mut limit, next, &mut reset, &mut bits, &mut count, &mut block,
                );
            }
            prefix = pixel as u16;
        }
        emit(
            prefix, &mut size, &mut limit, next, &mut reset, &mut bits, &mut count, &mut block,
        );
        emit(
            257, &mut size, &mut limit, next, &mut reset, &mut bits, &mut count, &mut block,
        );
        if count > 0 {
            block.push(bits as u8);
        }
        out.push(8);
        for chunk in block.chunks(255) {
            out.push(chunk.len() as u8);
            out.extend_from_slice(chunk);
        }
        out.push(0);
    }
    pub fn frame(&mut self, rgba: &[u8], index: usize) -> Result<Vec<u8>> {
        if !self.started
            || index != self.next
            || index >= 900
            || rgba.len() != self.width * self.height * 4
        {
            return Err("invalid GIF frame".into());
        }
        self.next += 1;
        let current: Vec<_> = rgba
            .chunks_exact(4)
            .map(|p| {
                self.nearest(
                    ((p[0] as usize >> 3) << 10)
                        | ((p[1] as usize >> 3) << 5)
                        | (p[2] as usize >> 3),
                )
            })
            .collect();
        let (mut left, mut top, mut right, mut bottom) = (0, 0, self.width - 1, self.height - 1);
        if let Some(prev) = &self.previous {
            left = self.width;
            top = self.height;
            let mut changed = false;
            for y in 0..self.height {
                for x in 0..self.width {
                    let p = y * self.width + x;
                    if current[p] == prev[p] {
                        continue;
                    }
                    if !changed {
                        right = x;
                        changed = true;
                    }
                    left = left.min(x);
                    right = right.max(x);
                    top = top.min(y);
                    bottom = y;
                }
            }
            if !changed {
                left = 0;
                right = 0;
                top = 0;
                bottom = 0;
            }
        }
        let w = right - left + 1;
        let h = bottom - top + 1;
        let mut pixels = Vec::with_capacity(w * h);
        for y in 0..h {
            for x in 0..w {
                let p = (top + y) * self.width + left + x;
                pixels.push(
                    if self
                        .previous
                        .as_ref()
                        .is_some_and(|prev| prev[p] == current[p])
                    {
                        255
                    } else {
                        current[p]
                    },
                );
            }
        }
        let delay = (((index + 1) as f64 * 100. / self.fps).round()
            - (index as f64 * 100. / self.fps).round()) as usize;
        let mut out = vec![0x21, 0xf9, 4, if self.previous.is_some() { 5 } else { 4 }];
        word(&mut out, delay);
        out.extend_from_slice(&[255, 0, 0x2c]);
        word(&mut out, left);
        word(&mut out, top);
        word(&mut out, w);
        word(&mut out, h);
        out.push(0);
        self.lzw(&pixels, &mut out);
        self.previous = Some(current);
        Ok(out)
    }
}
