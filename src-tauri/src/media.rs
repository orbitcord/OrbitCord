//! Private binary-framed media service. The parent owns authorization and jobs.
use crate::{archive, gif, mp4};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn run() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut files: HashMap<u64, File> = HashMap::new();
    let mut next = 0u64;
    let mut gifs: HashMap<u64, gif::Encoder> = HashMap::new();
    let mut roots = Vec::new();
    loop {
        let mut head = [0; 8];
        match input.read_exact(&mut head) {
            Ok(()) => (),
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e.into()),
        }
        let h = u32::from_le_bytes(head[..4].try_into()?) as usize;
        let n = u32::from_le_bytes(head[4..].try_into()?) as usize;
        if h > 65536 || n > 64 * 1024 * 1024 {
            return Err("oversized media request".into());
        }
        let mut header = vec![0; h];
        input.read_exact(&mut header)?;
        let mut bytes = vec![0; n];
        input.read_exact(&mut bytes)?;
        let request: Value = serde_json::from_slice(&header)?;
        let mut serialized = None;
        let result = (|| -> Result<(Value, Vec<u8>)> {
            let args = &request["args"];
            let command = request["command"].as_str().ok_or("command")?;
            let path = || args["path"].as_str().ok_or("path");
            let id = args["handle"].as_u64().unwrap_or(0);
            let mut data = Vec::new();
            let value = match command {
                "open" => {
                    let mut options = OpenOptions::new();
                    match args["flags"].as_str().ok_or("flags")? {
                        "r" => {
                            options.read(true);
                        }
                        "wx" => {
                            options.write(true).create_new(true);
                        }
                        "w" => {
                            options.write(true).create(true).truncate(true);
                        }
                        _ => return Err("flags".into()),
                    };
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let file = options.open(path()?)?;
                    next += 1;
                    files.insert(next, file);
                    json!(next)
                }
                "close" => {
                    files.remove(&id);
                    Value::Null
                }
                "read" => {
                    let file = files.get_mut(&id).ok_or("expired handle")?;
                    let length = args["length"].as_u64().ok_or("length")? as usize;
                    if length > 8 * 1024 * 1024 {
                        return Err("read limit".into());
                    }
                    if let Some(pos) = args["position"].as_u64() {
                        file.seek(SeekFrom::Start(pos))?;
                    }
                    data.resize(length, 0);
                    let n = file.read(&mut data)?;
                    data.truncate(n);
                    json!(n)
                }
                "write" => {
                    let file = files.get_mut(&id).ok_or("expired handle")?;
                    if let Some(pos) = args["position"].as_u64() {
                        file.seek(SeekFrom::Start(pos))?;
                    }
                    file.write_all(&bytes)?;
                    json!(bytes.len())
                }
                "stat" => {
                    let m = if id > 0 {
                        files.get(&id).ok_or("expired handle")?.metadata()?
                    } else {
                        fs::metadata(path()?)?
                    };
                    json!({"size":m.len(),"file":m.is_file()})
                }
                "mkdir" => {
                    fs::create_dir_all(path()?)?;
                    Value::Null
                }
                "mkdtemp" => {
                    let prefix = path()?;
                    let parent = Path::new(prefix).parent().ok_or("parent")?;
                    let name = Path::new(prefix)
                        .file_name()
                        .ok_or("prefix")?
                        .to_string_lossy();
                    let dir = tempfile::Builder::new()
                        .prefix(name.as_ref())
                        .tempdir_in(parent)?
                        .keep();
                    roots.push(dir.clone());
                    json!(dir.to_string_lossy())
                }
                "rm" => {
                    let p = Path::new(path()?);
                    roots.retain(|r| !r.starts_with(p));
                    if fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()) {
                        fs::remove_dir_all(p)?;
                    } else if p.exists() {
                        fs::remove_file(p)?;
                    }
                    Value::Null
                }
                "readdir" => {
                    let mut entries = Vec::new();
                    for e in fs::read_dir(path()?)? {
                        let e = e?;
                        entries.push(json!({"name":e.file_name().to_string_lossy(),"directory":e.file_type()?.is_dir()}));
                    }
                    json!(entries)
                }
                "inspect" => archive::inspect(path()?, args["name"].as_str().unwrap_or(""))?,
                "zip_directory" => {
                    serialized = Some(archive::directory(
                        &bytes,
                        args["count"].as_u64().ok_or("count")? as usize,
                    )?);
                    Value::Null
                }
                "zip_inflate" => {
                    data = archive::inflate(&bytes)?;
                    Value::Null
                }
                "mp4" => {
                    mp4::mux(
                        args["video"].as_str().ok_or("video")?,
                        args["audio"].as_str().ok_or("audio")?,
                        path()?,
                    )?;
                    json!({"size":fs::metadata(path()?)?.len()})
                }
                "gif_new" => {
                    if gifs.len() >= 2 {
                        return Err("GIF busy".into());
                    }
                    next += 1;
                    gifs.insert(next, gif::Encoder::new(args)?);
                    json!(next)
                }
                "gif_sample" => {
                    gifs.get_mut(&id).ok_or("expired GIF")?.sample(&bytes)?;
                    Value::Null
                }
                "gif_start" => {
                    data = gifs.get_mut(&id).ok_or("expired GIF")?.start();
                    Value::Null
                }
                "gif_frame" => {
                    data = gifs
                        .get_mut(&id)
                        .ok_or("expired GIF")?
                        .frame(&bytes, args["index"].as_u64().ok_or("index")? as usize)?;
                    Value::Null
                }
                "gif_close" => {
                    gifs.remove(&id);
                    Value::Null
                }
                _ => return Err("unknown media command".into()),
            };
            Ok((value, data))
        })();
        let (response, data) = match result {
            Ok((v, b)) => (json!({"id":request["id"],"result":v}), b),
            Err(e) => (json!({"id":request["id"],"error":e.to_string()}), vec![]),
        };
        let header = if response.get("error").is_none() && serialized.is_some() {
            let mut header = format!("{{\"id\":{},\"result\":", request["id"]).into_bytes();
            header.extend(serialized.unwrap());
            header.push(b'}');
            header
        } else {
            serde_json::to_vec(&response)?
        };
        output.write_all(&(header.len() as u32).to_le_bytes())?;
        output.write_all(&(data.len() as u32).to_le_bytes())?;
        output.write_all(&header)?;
        output.write_all(&data)?;
        output.flush()?;
    }
    drop(files);
    for path in roots.into_iter().rev() {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}
