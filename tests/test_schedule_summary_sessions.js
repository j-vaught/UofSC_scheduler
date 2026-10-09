const test = require('node:test');
const assert = require('node:assert/strict');
const {createSummaryPart} = require('../static/js/features/scheduler/summary.js');
function feature() {
    const calls={grades:0,credits:0};
    const api=createSummaryPart({state:{term:'202701',selectedCourses:{}},api:{async getDetails(){calls.credits++;return {};}}});
    api.parseCreditHours=value=>Number.isFinite(Number(value))&&value!=null?Number(value):null;
    api.scheduleSectionData=async section=>{calls.grades++;return {grades:{average_gpa:3.555555,graded_students:100},faculty:section.missing?[]:[{grade:{average_gpa:section.gpa,graded_students:100}}]};};
    api.currentInstructorSummaries=(_,grades,faculty)=>faculty;
    return {api,calls};
}
test('shared summaries retain raw GPA precision and reuse each section history',async()=>{
    const {api,calls}=feature();
    const a={code:'TEST 101',crn:'a',hours:3,gpa:3.123456};
    const b={code:'TEST 102',crn:'b',hours:4,gpa:2.765432};
    const result=await api.scheduleGradeEstimate([a,b]);
    assert.equal(result.value,(3*3.123456+4*2.765432)/7);
    assert.equal(result.estimate,result.value.toFixed(2));
    assert.equal(result.completeness,'complete');
    await api.scheduleGradeEstimate([b,a]);
    await api.scheduleGradeEstimate([a]);
    assert.equal(calls.grades,2);
});
test('fallback GPA covers known credits while excluded credits make the estimate partial',async()=>{
    const {api}=feature();
    const fallback={code:'TEST 101',crn:'a',hours:3,missing:true};
    const missingCredits={code:'TEST 102',crn:'b',gpa:3};
    const full=await api.scheduleGradeEstimate([fallback]);
    assert.equal(full.value,3.555555);
    assert.equal(full.completeness,'complete');
    assert.match(full.missing[0].reason,/course-wide/);
    const partial=await api.scheduleGradeEstimate([fallback,missingCredits]);
    assert.equal(partial.value,3.555555);
    assert.equal(partial.completeness,'partial');
    assert.match(partial.missing[1].reason,/Credit hours unavailable/);
});
test('all scheduler data requests share a four-request concurrency ceiling',async()=>{
    const {api}=feature();let active=0,peak=0;
    const values=await Promise.all(Array.from({length:30},(_,index)=>api.scheduleDataRequest(async()=>{
        active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return index;
    })));
    assert.equal(peak,4);assert.equal(values.length,30);
});
