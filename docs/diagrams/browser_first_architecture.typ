#import "@preview/cetz:0.5.2"

#set page(width: 14in, height: 6.75in, margin: 0.22in, fill: white)
#set text(font: "New Computer Modern", size: 8pt)

#let garnet = rgb("#73000A")
#let black90 = rgb("#363636")
#let black70 = rgb("#5C5C5C")
#let black30 = rgb("#C7C7C7")
#let black10 = rgb("#ECECEC")
#let atlantic = rgb("#466A9F")
#let horseshoe = rgb("#65780B")
#let honeycomb = rgb("#A49137")
#let sandstorm = rgb("#FFF2E3")
#let pale-blue = rgb("#E8EEF6")
#let pale-green = rgb("#EFF3E2")

#cetz.canvas(length: 0.45in, y: -1, background: white, padding: 0.08, {
  import cetz.draw: *

  let card(x, y, w, h, title, body, fill: white, stroke: black70, title-color: black90) = {
    rect((x, y), (x + w, y + h), fill: fill, stroke: 1.1pt + stroke, radius: 0pt)
    content(
      (x + 0.28, y + 0.28),
      anchor: "north-west",
      block(
        width: (w - 0.56) * 0.45in,
        stack(
          dir: ttb,
          spacing: 3pt,
          text(size: 8.2pt, weight: "bold", fill: title-color, title),
          text(size: 6.7pt, fill: black90, body),
        ),
      ),
    )
  }

  let lane(x, y, w, h, title, fill, stroke) = {
    rect((x, y), (x + w, y + h), fill: fill, stroke: 1.2pt + stroke, radius: 0pt)
    rect((x, y), (x + w, y + 0.78), fill: stroke, stroke: none, radius: 0pt)
    content(
      (x + 0.28, y + 0.39),
      anchor: "west",
      text(size: 8.8pt, weight: "bold", fill: white, title),
    )
  }

  let arrow(x1, y1, x2, y2, color: black70) = {
    line((x1, y1), (x2, y2), stroke: 1.5pt + color, mark: (end: ">"))
  }

  rect((0, 0), (29.6, 1.18), fill: garnet, stroke: none, radius: 0pt)
  content((0.45, 0.4), anchor: "west", text(size: 15pt, weight: "bold", fill: white)[Browser-First Static Architecture])
  content((29.15, 0.4), anchor: "east", text(size: 7pt, fill: white)[UofSC Course Scheduler · J.C. Vaught])

  lane(0.45, 1.62, 8.25, 12.28, [OFFLINE OR SCHEDULED BUILD], black10, black90)
  lane(9.02, 1.62, 8.1, 12.28, [STATIC HOSTING], sandstorm, honeycomb)
  lane(17.44, 1.62, 11.7, 12.28, [STUDENT DESKTOP BROWSER], pale-blue, atlantic)

  card(0.85, 2.78, 3.35, 2.05, [Source records], [Registrar grade workbooks; completed-term section records; Academic Bulletin catalog; campus buildings and major maps], fill: white, stroke: black70)
  card(4.65, 2.78, 3.62, 2.05, [Build entry points], [grade_pipeline.py; scrape_courses.py; build_embeddings.py; sync_campus_buildings.py], fill: white, stroke: black70)
  arrow(4.2, 3.8, 4.65, 3.8)

  card(0.85, 5.35, 3.35, 2.2, [Static release tools], [build_offering_history.py; build_catalog_shards.py; build_grade_shards.py; build_static_release.py; build_static_site.py], fill: pale-green, stroke: horseshoe, title-color: horseshoe)
  card(4.65, 5.35, 3.62, 2.2, [Validation], [Schema and privacy checks; coverage and duplicate checks; parity fixtures; bundle-size and hash checks], fill: pale-green, stroke: horseshoe, title-color: horseshoe)
  arrow(4.2, 6.45, 4.65, 6.45, color: horseshoe)

  card(0.85, 8.15, 7.42, 2.38, [Generated release], [Course and professor grade aggregates; sparse offering history with completed-term coverage; catalog and embedding bundles; building aliases, maps, and notices], fill: white, stroke: black70)
  card(0.85, 11.02, 7.42, 2.25, [Release rule], [Write immutable, content-hashed bundles first. Publish the small mutable `manifest.json` last so browsers never see a partial release.], fill: pale-green, stroke: horseshoe, title-color: horseshoe)
  arrow(4.56, 7.55, 4.56, 8.15, color: horseshoe)
  arrow(4.56, 10.53, 4.56, 11.02, color: horseshoe)

  card(9.42, 2.78, 7.3, 1.75, [Application shell], [static/index.html; static/css; static/js; service worker and browser workers], fill: white, stroke: honeycomb, title-color: garnet)
  card(9.42, 5.02, 7.3, 2.0, [Stable release entry point], [static/data/manifest.json; schema version; release ID; coverage; artifact URLs; sizes; hashes], fill: white, stroke: honeycomb, title-color: garnet)
  card(9.42, 7.5, 7.3, 3.45, [Immutable data tree], [catalog course and subject bundles; grades/course subject shards; grades/professor prefix shards; history subject shards; search embeddings and PCA parameters; campus buildings and notices], fill: white, stroke: honeycomb, title-color: garnet)
  card(9.42, 11.43, 7.3, 1.84, [Cache policy], [Revalidate only the manifest. Cache hashed bundles indefinitely and replace them only when the manifest changes.], fill: pale-green, stroke: horseshoe, title-color: horseshoe)
  arrow(8.27, 9.34, 9.42, 9.34, color: horseshoe)

  card(17.86, 2.78, 3.32, 2.02, [Interface shell], [Search and course details; schedule options and map; grades and history; registration handoff], fill: white, stroke: atlantic, title-color: atlantic)
  card(21.58, 2.78, 3.32, 2.02, [Background data loader], [Render first, load the manifest, warm semantic search, and fetch selected-subject artifacts on demand.], fill: white, stroke: atlantic, title-color: atlantic)
  card(25.3, 2.78, 3.42, 2.02, [Local persistence], [Cache Storage for immutable files; IndexedDB for release metadata and fallback records; local storage for plans and preferences], fill: white, stroke: atlantic, title-color: atlantic)
  arrow(21.18, 3.79, 21.58, 3.79, color: atlantic)
  arrow(24.9, 3.79, 25.3, 3.79, color: atlantic)

  card(17.86, 5.38, 5.13, 2.38, [Browser workers], [solver-worker.js for schedule generation; transcript-worker.js; degree-planner-worker.js; offering-analysis-worker.js], fill: pale-blue, stroke: atlantic, title-color: atlantic)
  card(23.4, 5.38, 5.32, 2.38, [Interface modules], [search.js · scheduler.js · grades.js · history.js · map.js · api.js. The interface and semantic-result orchestration remain on the main thread.], fill: white, stroke: atlantic, title-color: atlantic)
  arrow(23.0, 6.57, 23.4, 6.57, color: atlantic)

  card(17.86, 8.25, 5.13, 2.32, [Live current-term overlay], [Sections, seats, CRNs, meeting times, locations, instructors, and registration restrictions], fill: sandstorm, stroke: garnet, title-color: garnet)
  card(23.4, 8.25, 5.32, 2.32, [University systems], [Live course and bulletin APIs; official registration page; course-specific syllabus archive link], fill: white, stroke: garnet, title-color: garnet)
  arrow(23.0, 9.41, 23.4, 9.41, color: garnet)

  card(17.86, 11.05, 10.86, 2.22, [Deployment dependency], [Direct live search works only if the final deployment origin receives browser access from the University APIs or the static application is served from an allowed origin. Desktop-only delivery does not remove this browser security requirement.], fill: sandstorm, stroke: garnet, title-color: garnet)

  arrow(16.72, 3.65, 17.86, 3.65, color: honeycomb)
  arrow(16.72, 8.86, 21.58, 4.8, color: horseshoe)
})
