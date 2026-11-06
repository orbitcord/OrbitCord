const { spawn } = require('node:child_process');
let executable = process.env.LOWCORD_NATIVE_MEDIA, shared;
const services = new Set();
class MediaService {
    constructor(binary = executable) {
        if (!binary) throw new Error('Native media backend is not configured');
        this.child = spawn(binary, ['--media-service'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
        this.pending = new Map(); this.next = 0; this.parts = []; this.length = 0; this.expected = 8;
        this.header = null; this.error = null; services.add(this);
        this.child.on('error', error => this.fail(error));
        this.child.once('exit', () => { this.fail(new Error('Native media backend exited')); services.delete(this); });
        this.child.stdin.on('error', error => this.fail(error));
        this.child.stdout.on('data', chunk => this.receive(chunk));
        this.active(false);
    }
    active(value) {
        for(const stream of [this.child,this.child.stdin,this.child.stdout]) stream[value ? 'ref' : 'unref']?.();
    }
    receive(chunk) {
        while (chunk.length) {
            const n = Math.min(chunk.length, this.expected - this.length);
            this.parts.push(chunk.subarray(0,n)); this.length += n; chunk = chunk.subarray(n);
            if (this.length !== this.expected) continue;
            const bytes = Buffer.concat(this.parts, this.length); this.parts=[]; this.length=0;
            if (!this.header) {
                const h=bytes.readUInt32LE(0), n=bytes.readUInt32LE(4);
                if (h<2 || h>8*1024*1024 || n>64*1024*1024) { this.fail(new Error('Invalid media response')); this.child.kill(); return; }
                this.header={ h,n }; this.expected=h+n;
            } else {
                const {h}=this.header; this.header=null; this.expected=8;
                try {
                    const result=JSON.parse(bytes.toString('utf8',0,h)); const entry=this.pending.get(result.id);
                    if (!entry) continue;
                    this.pending.delete(result.id); clearTimeout(entry.timer);
                    if(!this.pending.size)this.active(false);
                    if (result.error) entry.reject(new Error(result.error)); else entry.resolve({value:result.result,bytes:bytes.subarray(h)});
                } catch(error) { this.fail(error); this.child.kill(); return; }
            }
        }
    }
    call(command,args={},bytes=Buffer.alloc(0),timeout=30_000) {
        if (this.error) return Promise.reject(this.error);
        if(this.pending.size>=128) return Promise.reject(new Error('Native media busy'));
        return new Promise((resolve,reject)=>{
            const id=++this.next, json=Buffer.from(JSON.stringify({id,command,args}));
            if(json.length>65536 || bytes.length>64*1024*1024) {reject(new Error('Media request too large'));return;}
            this.active(true);
            const timer=setTimeout(()=>{this.fail(new Error(`Native media timed out: ${command}`));this.child.kill();},timeout);
            this.pending.set(id,{resolve,reject,timer});
            const head=Buffer.alloc(8);head.writeUInt32LE(json.length);head.writeUInt32LE(bytes.length,4);
            this.child.stdin.cork();this.child.stdin.write(head);this.child.stdin.write(json);this.child.stdin.write(bytes);this.child.stdin.uncork();
        });
    }
    fail(error){this.error=error;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();}
    close(){this.child.stdin.end();}
}
function configure(binary){executable=binary;}
function enabled(){return !!executable;}
function service(){if(!shared||shared.error)shared=new MediaService();return shared;}
function close(){for(const s of services)s.close();shared=null;}
async function mux(video,audio,path,{signal}={}) {
    signal?.throwIfAborted();const job=new MediaService();
    const abort=()=>job.child.kill();signal?.addEventListener('abort',abort,{once:true});
    try{return (await job.call('mp4',{video,audio,path},undefined,300_000)).value;}
    finally{signal?.removeEventListener('abort',abort);job.close();}
}
module.exports={MediaService,configure,enabled,service,close,mux};
