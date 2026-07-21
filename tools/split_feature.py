"""Split a fenced feature's object literal into part files.

Used for the search and scheduler features, and kept because the next module
that outgrows one file should be cut the same way rather than by hand.

The safety property is the same one the search split relied on: cuts happen at
member boundaries only, so concatenating the parts reproduces the original
object body exactly. That is asserted before anything is written.
"""


def split(feature, factory_name, parts_spec):
    path = f"static/js/features/{feature}/index.js"
    src = open(path).read()
    lines = src.split("\n")

    first_method = parts_spec[0][2] - 1
    head = lines[:first_method]
    # The object may close on its own line, or be jammed onto the last member
    # as `},};` -- an artefact of how these files were first assembled.
    close_i = None
    for i in range(len(lines) - 1, first_method, -1):
        stripped = lines[i].strip()
        if stripped == "};" or stripped.endswith("},};"):
            close_i = i
            break
    if close_i is None:
        raise SystemExit("Could not find the end of the feature object")

    if lines[close_i].strip().endswith("},};"):
        methods = lines[first_method:close_i] + [lines[close_i].replace("},};", "},")]
        after = lines[close_i + 1 :]
    else:
        methods = lines[first_method:close_i]
        after = lines[close_i + 1 :]

    def rel(n):
        return n - 1 - first_method

    chunks = []
    for idx, (name, fn, start, why) in enumerate(parts_spec):
        end = parts_spec[idx + 1][2] if idx + 1 < len(parts_spec) else None
        lo, hi = rel(start), (rel(end) if end else len(methods))
        chunks.append((name, fn, methods[lo:hi], why))

    rebuilt = "\n".join("\n".join(c[2]) for c in chunks)
    if rebuilt != "\n".join(methods):
        raise SystemExit("SPLIT WOULD LOSE CODE — aborting")
    print("method region reassembles exactly: True")

    for name, fn, body, why in chunks:
        header = f"""/*
 * {why}.
 *
 * One part of the {feature} feature, which was a single module of over two
 * thousand lines. Each part is a factory returning plain methods; index.js
 * merges them onto one object, so `this` still reaches every method and no
 * call site changed.
 *
 * Cut at member boundaries only, so concatenating the parts in order
 * reproduces the original object body exactly.
 */
(function init{fn[6:]}(root, factory) {{
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (!root.{factory_name}Parts) root.{factory_name}Parts = {{}};
    root.{factory_name}Parts.{fn} = api.{fn};
}}(typeof globalThis === 'object' ? globalThis : self, () => {{
    'use strict';

    function {fn}(deps) {{
        return {{
"""
        footer = "        };\n    }\n\n    return { %s };\n}));\n" % fn
        open(f"static/js/features/{feature}/{name}", "w").write(
            header + "\n".join(body) + "\n" + footer
        )
        print(f"  {name:16} {len(body):5} lines  {fn}")

    resolve = "\n".join(
        f"""        const {fn} = (typeof {factory_name}Parts !== 'undefined' && {factory_name}Parts.{fn})
            || (typeof require === 'function' ? require('./{name}').{fn} : null);"""
        for name, fn, *_ in chunks
    )
    missing = " || ".join(f"!{fn}" for _, fn, *_ in chunks)
    assigns = ",\n".join(f"            {fn}(deps)" for _, fn, *_ in chunks)

    composition = f"""        }};

        /*
         * The methods live in part files, merged onto the object above.
         *
         * Merging rather than delegating keeps `this` working: every method
         * still reaches every other one and the shared state, so splitting the
         * file changed no call site. Cuts are at member boundaries only, so the
         * parts concatenate back into the original body exactly.
         */
{resolve}

        if ({missing}) {{
            throw new Error('{feature} feature parts are not loaded');
        }}

        Object.assign(
            feature,
{assigns},
        );
"""
    open(path, "w").write("\n".join(head) + "\n" + composition + "\n" + "\n".join(after) + "\n")
    print("index.js rewritten")
