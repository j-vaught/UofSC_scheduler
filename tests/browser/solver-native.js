/* Browser acceptance harness. Uses an isolated synthetic planning term. */
'use strict';
const report = document.getElementById('report');
const button = document.getElementById('run');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const line = message => { report.textContent += `${message}\n`; };
const clone = value => JSON.parse(JSON.stringify(value));
button.addEventListener('click', async () => {
    button.disabled = true;
    report.textContent = '';
    try {
        const params = { term: 'qa-native', courses: Array.from({length:3}, (_,course)=>({code:`QA ${course}`,sections:Array.from({length:8},(_,section)=>({crn:`${course}-${section}`,section:'J01',code:`QA ${course}`,hours:1,meets:'Online asynchronous',meetingTimes:'[]'}))})), preferences:{} };
        let store = await SolverStore.open({term:params.term,inputRevision:`test-${Date.now()}`,params});
        check(store.persistent,'Native IndexedDB unavailable');
        const sessionId = store.meta.session_id;
        const inputRevision = store.meta.input_revision;
        params.session_id = sessionId; params.input_revision = inputRevision;
        const measurements = {first:null,start:performance.now(),pause:null};
        const client = SolverClient.create(params,{runBudgetMs:30000,onBatch:async batch=>{await store.commitBatch(batch);if(!measurements.first&&batch.results.length) measurements.first=performance.now()-measurements.start;}});
        const complete = await client.start();
        check(complete.state==='complete' && store.meta.total_found===512,'512 exhaustive schedules expected');
        line(`PASS worker search. 512 schedules. First durable result ${measurements.first.toFixed(1)} ms.`);
        await store.publish('best');
        const first = await store.page(0,10);
        const last = await store.page(510,10);
        check(first.results.length===10 && last.results.length===2 && last.total===512,'Cursor pagination failed');
        line('PASS native cursor pagination covers first and last pages.');
        const row = first.results[0];
        await store.updateMetrics(row.id,{gpa:{value:3.123456,completeness:'complete'},walking:{value:2.5,completeness:'complete'},ready:true});
        check(!(await store.page(0,10)).results[0].metrics.ready,'Published snapshot changed before Update');
        line('PASS metric updates remain staged.');
        for(const sort of ['best','days','walking','gaps','later','gpa','online']) {
            await store.publish(sort);
            const page = await store.page(0,10);
            check(page.total===512 && page.sort===sort,'Sort count changed');
        }
        line('PASS all seven indexed sorts retain every schedule.');
        const checkpoint = clone(store.meta.checkpoint);
        const savedRevision = store.meta.publishedRevision;
        store.close();
        store = await SolverStore.open({term:params.term,inputRevision,params});
        check(store.meta.session_id===sessionId && JSON.stringify(store.meta.checkpoint)===JSON.stringify(checkpoint) && store.meta.publishedRevision===savedRevision,'Refresh restore failed');
        check((await store.page(0,10)).total===512,'Restored snapshot missing');
        line('PASS close/reopen restores checkpoint, result count, and snapshot.');
        let staleRejected=false;
        try {await store.commitBatch({session_id:'stale',results:[]});} catch {staleRejected=true;}
        check(staleRejected,'Stale batch was accepted');
        line('PASS stale session writes rejected.');
        client.dispose(); store.close();
        const hard = {term:'qa-hard', session_id:'qa-hard',input_revision:'hard-1', courses:Array.from({length:12},(_,course)=>({code:`HARD ${course}`,sections:Array.from({length:20},(_,section)=>({crn:`${course}-${section}`,section:'J01',hours:1,meets:'Online asynchronous',meetingTimes:'[]'}))})),preferences:{}};
        let found=0, pausedCheckpoint=null;
        const hardClient = SolverClient.create(hard,{onBatch:async batch=>{found+=batch.results.length;pausedCheckpoint=batch.checkpoint;}});
        const run = hardClient.start();
        await new Promise(resolve=>setTimeout(resolve,100));
        const pauseAt=performance.now();
        const paused=await hardClient.pause();
        measurements.pause=performance.now()-pauseAt;
        await run;
        check(paused.state==='paused' && measurements.pause<500 && pausedCheckpoint,'Pause latency exceeded500ms');
        line(`PASS difficult worker search pauses in ${measurements.pause.toFixed(1)} ms. ${found} results retained.`);
        hardClient.dispose();
        let resumed=0;
        const resumedClient=SolverClient.create(hard,{checkpoint:pausedCheckpoint,runBudgetMs:50,onBatch:async batch=>{resumed+=batch.results.length;}});
        const resumedResult=await resumedClient.resume();
        check(resumed>0 && resumedResult.checkpoint.total_found>pausedCheckpoint.total_found,'Checkpoint continuation failed');
        resumedClient.dispose();
        line('PASS fresh worker continues from the saved stack.');
        const local=SolverClient.create({...params,session_id:'qa-local'},{useWorker:false,onBatch:async()=>{}});
        check((await local.start()).state==='complete','Yielding fallback failed'); local.dispose();
        line('PASS no-worker yielding engine.');
        line('ALL NATIVE ACCEPTANCE CHECKS PASSED');
    } catch(error) {line(`FAIL ${error.stack || error.message}`);}
    button.disabled=false;
});
