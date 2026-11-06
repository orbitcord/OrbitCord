//! Private binary-framed media service. The parent owns authorization and jobs.
use crate::gif;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, Read, Write},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn run() -> Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut next = 0u64;
    let mut gifs: HashMap<u64, gif::Encoder> = HashMap::new();
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
        let result = (|| -> Result<(Value, Vec<u8>)> {
            let args = &request["args"];
            let command = request["command"].as_str().ok_or("command")?;
            let id = args["handle"].as_u64().unwrap_or(0);
            let mut data = Vec::new();
            let value = match command {
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
        let header = serde_json::to_vec(&response)?;
        output.write_all(&(header.len() as u32).to_le_bytes())?;
        output.write_all(&(data.len() as u32).to_le_bytes())?;
        output.write_all(&header)?;
        output.write_all(&data)?;
        output.flush()?;
    }
    Ok(())
}
