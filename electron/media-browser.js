(() => {
    const find=id=>document.getElementById(id);let current;
    async function run(action,value){try{const result=await window.mediaBrowser.run(action,value);if(result?.error)find('status').textContent=result.error;}catch{find('status').textContent='The source browser is unavailable. Close and reopen it.';}}
    window.mediaBrowser.onState(state=>{
        current=state;
        if(!find('source').options.length)for(const source of state.sources)find('source').append(new Option(source.name,source.id));
        find('source').value=state.source;
        find('destination').textContent=`To: ${state.destination}`;find('destination').title=state.destination;
        if(document.activeElement!==find('address'))find('address').value=state.url;
        find('status').textContent=state.status;find('status').title=state.status;
        find('save').textContent=state.saved.some(page=>page.url===state.url)?'Unsave page':'Save page';
        find('saved').replaceChildren(new Option('Saved pages',''));
        for(const page of state.saved)find('saved').append(new Option(page.title,page.url));
        find('cancel').hidden=!state.busy;
        for(const id of ['source','picker','logout','reload','address','go','save','saved'])find(id).disabled=state.busy;
        find('back').disabled=state.busy||!state.canBack;find('forward').disabled=state.busy||!state.canForward;
    });
    for(const id of ['back','forward','reload','logout','cancel','picker','save'])find(id).onclick=()=>void run(id);
    find('saved').onchange=()=>{if(find('saved').value)void run('saved',find('saved').value);};
    find('source').onchange=()=>void run('source',find('source').value);
    find('navigation').onsubmit=event=>{event.preventDefault();find('address').blur();void run('navigate',find('address').value);};
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!current?.busy)void run('picker');});
    void run('state');
})();
