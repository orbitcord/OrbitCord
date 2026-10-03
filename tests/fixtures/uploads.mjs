window.prepared=[];
window.receipts=[];
let controller;
// Discord's native prepare order: File array, compression metadata, then
// draft/upload objects. Lowcord ships no upload interception, so the fixture
// exercises that order directly with the caller's original File bytes.
async function prepare(files){
    const inputs=Array.from(files);
    const metadata=inputs.map(file=>({originalContentType:file.type,preCompressionSize:file.size}));
    return inputs.map((file,index)=>({file,compressionMetadata:metadata[index]}));
}
async function add(files) {
    document.querySelector('#state').textContent="Preparing";
    const entries=await prepare(Array.from(files));
    window.prepared.push(...entries);
    for(const {file,compressionMetadata} of entries) {
        const card=document.createElement('article'); card.dataset.type=file.type;
        const name=document.createElement('span');name.textContent=file.name;card.append(name);
        if(file.type.startsWith('image/')) {
            const image=document.createElement('img');image.alt=file.name;image.src=URL.createObjectURL(file);
            card.append(image);
            image.onload=()=>{card.dataset.preview="ready";};
            image.onerror=()=>{card.dataset.preview="error";};
        }
        card.dataset.size=String(file.size);card.dataset.metadataSize=String(compressionMetadata.preCompressionSize);
        document.querySelector('#drafts').append(card);
    }
    document.querySelector('#state').textContent="Ready";
}
document.querySelector('#files').onchange=event=>add(event.target.files);
document.querySelector('#drop').ondragover=event=>event.preventDefault();
document.querySelector('#drop').ondrop=event=>{event.preventDefault();void add(event.dataTransfer.files);};
document.querySelector('#cancel').onclick=()=>controller?.abort();
document.querySelector('#send').onclick=async()=>{
    controller=new AbortController();document.querySelector('#state').textContent="Uploading";
    try {
        for(const {file} of window.prepared) {
            const response=await fetch('/upload'+location.search,{method:'POST',body:file,signal:controller.signal});
            if(!response.ok)throw Error('Upload failed');
            window.receipts.push(await response.json());
        }
        document.querySelector('#results').textContent=String(window.receipts.length)+' uploaded';
        window.prepared=[];document.querySelector('#drafts').replaceChildren();
        document.querySelector('#state').textContent="Sent";
    }catch(error){document.querySelector('#state').textContent=error.name==='AbortError'?'Cancelled':'Failed';}
};
