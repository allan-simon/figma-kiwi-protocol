#!/usr/bin/env python3
"""
Query the local Figma scenegraph JSON (decoded from WebSocket Kiwi frames).
Fallback when the REST API is rate-limited.

Usage:
  python3 figma_local.py pages                    # list all pages (CANVAS nodes)
  python3 figma_local.py page <name> [--depth N]  # show page tree
  python3 figma_local.py node <name_or_id>        # show node detail
  python3 figma_local.py search <pattern>         # find nodes by name
  python3 figma_local.py texts <page_name>        # extract all text from a page
  python3 figma_local.py css <name_or_id>         # extract CSS-like properties
  python3 figma_local.py interactions <name_or_id> # show prototype interactions (recursive)
  python3 figma_local.py components [<pattern>]   # list all components (optionally filter by name)
  python3 figma_local.py component <name_or_id>   # detailed view of a component (variants, props, tree)
  python3 figma_local.py instances <name_or_id>   # find all instances of a component
"""

import json
import os
import sys
import re
from pathlib import Path

KIWI_DIR = Path(os.environ.get("FIGMA_KIWI_DIR", "/tmp/figma_kiwi"))
SCENEGRAPH = KIWI_DIR / "scenegraph.json"

def load():
    if not SCENEGRAPH.exists():
        print("No local scenegraph. Run the capture pipeline first:", file=sys.stderr)
        print("  1. Open Figma file in Chrome", file=sys.stderr)
        print("  2. figma-kiwi-protocol capture-all-pages", file=sys.stderr)
        print("  3. figma-kiwi-protocol decode", file=sys.stderr)
        sys.exit(1)
    with open(SCENEGRAPH) as f:
        return json.load(f)

def node_id(nc):
    """Build Figma-style node ID from guid."""
    g = nc.get("guid", {})
    sid = g.get("sessionID", 0)
    lid = g.get("localID", 0)
    return f"{sid}:{lid}"

def build_tree(data):
    """Build parent-child tree from flat nodeChanges list."""
    nodes = {}
    for nc in data.get("nodeChanges", []):
        nid = node_id(nc)
        nodes[nid] = {
            "id": nid,
            "name": nc.get("name", ""),
            "type": nc.get("type", "UNKNOWN"),
            "visible": nc.get("visible", True),
            "children": [],
            "_raw": nc,
        }

    # Build parent-child via parentIndex
    for nc in data.get("nodeChanges", []):
        nid = node_id(nc)
        pi = nc.get("parentIndex", {})
        pg = pi.get("guid", {})
        if pg:
            pid = f"{pg.get('sessionID', 0)}:{pg.get('localID', 0)}"
            if pid in nodes and pid != nid:
                pos = pi.get("position", "")
                nodes[pid]["children"].append((pos, nid))

    # Sort children by position
    for n in nodes.values():
        n["children"].sort(key=lambda x: x[0])
        n["children"] = [cid for _, cid in n["children"]]

    return nodes

def find_pages(nodes):
    """Find CANVAS nodes (pages)."""
    return {nid: n for nid, n in nodes.items() if n["type"] == "CANVAS"}

def find_by_name(nodes, pattern):
    """Case-insensitive search by name."""
    pat = re.compile(re.escape(pattern), re.IGNORECASE)
    return {nid: n for nid, n in nodes.items() if pat.search(n["name"])}

def find_by_id(nodes, node_id_str):
    """Find by ID (supports both 0:1 and 0-1 formats)."""
    normalized = node_id_str.replace("-", ":")
    return nodes.get(normalized)

def print_tree(nodes, nid, depth=3, indent=0, max_depth=None):
    if max_depth is not None and indent > max_depth:
        return
    n = nodes.get(nid)
    if not n:
        return
    prefix = "  " * indent
    vis = "" if n["visible"] else " [hidden]"
    raw = n["_raw"]

    # Text content
    text = ""
    if n["type"] == "TEXT" and raw.get("textData", {}).get("characters"):
        text = f' → "{raw["textData"]["characters"][:80]}"'

    name = n["name"][:60]
    print(f"{prefix}[{n['type']}] {name} ({nid}){vis}{text}")

    if indent < depth:
        for cid in n["children"]:
            print_tree(nodes, cid, depth, indent + 1, max_depth)
        if len(n["children"]) == 0 and indent == depth - 1:
            pass  # leaf

def extract_css(raw):
    """Extract CSS-like properties from a raw node."""
    css = {}
    size = raw.get("size", {})
    if size:
        css["width"] = f"{size.get('x', 0):.0f}px"
        css["height"] = f"{size.get('y', 0):.0f}px"

    # Stack/flex properties
    sm = raw.get("stackMode")
    if sm and sm != "NONE":
        css["display"] = "flex"
        if sm == "VERTICAL":
            css["flex-direction"] = "column"
        else:
            css["flex-direction"] = "row"

    spacing = raw.get("stackSpacing")
    if spacing is not None:
        css["gap"] = f"{spacing:.0f}px"

    # Padding
    pt = raw.get("stackVerticalPadding", raw.get("stackPadding", 0))
    pl = raw.get("stackHorizontalPadding", raw.get("stackPadding", 0))
    pb = raw.get("stackPaddingBottom", pt)
    pr = raw.get("stackPaddingRight", pl)
    if any([pt, pl, pb, pr]):
        css["padding"] = f"{pt:.0f}px {pr:.0f}px {pb:.0f}px {pl:.0f}px"

    # Corner radius
    cr = raw.get("cornerRadius")
    if cr:
        css["border-radius"] = f"{cr:.0f}px"

    # Opacity
    op = raw.get("opacity")
    if op is not None and op != 1:
        css["opacity"] = f"{op:.2f}"

    # Background (fill paints)
    fills = raw.get("fillPaints", [])
    for fill in fills:
        if fill.get("type") == "SOLID" and fill.get("visible", True):
            c = fill.get("color", {})
            r, g, b = int(c.get("r", 0) * 255), int(c.get("g", 0) * 255), int(c.get("b", 0) * 255)
            a = c.get("a", 1)
            op2 = fill.get("opacity", 1)
            alpha = a * op2
            if alpha < 1:
                css["background"] = f"rgba({r}, {g}, {b}, {alpha:.2f})"
            else:
                css["background"] = f"#{r:02x}{g:02x}{b:02x}"

    # Typography
    td = raw.get("textData", {})
    if td:
        chars = td.get("characters")
        if chars:
            css["text"] = chars[:200]
        fn = raw.get("fontName", {})
        if fn:
            css["font-family"] = fn.get("family", "")
            css["font-style"] = fn.get("style", "")
        fs = raw.get("fontSize")
        if fs:
            css["font-size"] = f"{fs:.0f}px"
        lh = raw.get("lineHeight", {})
        if lh and lh.get("value"):
            css["line-height"] = f"{lh['value']:.0f}px"
        ls = raw.get("letterSpacing", {})
        if ls and ls.get("value"):
            units = ls.get("units", "PIXELS")
            if units == "PERCENT":
                css["letter-spacing"] = f"{ls['value']:.1f}%"
            else:
                css["letter-spacing"] = f"{ls['value']:.2f}px"
        ta = raw.get("textAlignHorizontal")
        if ta and ta != "LEFT":
            css["text-align"] = ta.lower()

    # Stroke
    strokes = raw.get("strokePaints", [])
    sw = raw.get("strokeWeight")
    if sw and strokes:
        c = strokes[0].get("color", {})
        r, g, b = int(c.get("r", 0) * 255), int(c.get("g", 0) * 255), int(c.get("b", 0) * 255)
        css["border"] = f"{sw:.0f}px solid #{r:02x}{g:02x}{b:02x}"

    return css

def extract_texts(nodes, nid, results=None):
    """Recursively extract all text nodes from a subtree."""
    if results is None:
        results = []
    n = nodes.get(nid)
    if not n:
        return results
    raw = n["_raw"]
    if n["type"] == "TEXT":
        chars = raw.get("textData", {}).get("characters", "")
        if chars:
            results.append({"id": nid, "name": n["name"], "text": chars})
    for cid in n["children"]:
        extract_texts(nodes, cid, results)
    return results

def extract_state_machine(nodes, parent_nid, variant_ids):
    """Build a state machine from prototype interactions within a component's variants."""
    # Map variant node IDs to their state names
    variant_names = {}
    for vid in variant_ids:
        vn = nodes.get(vid)
        if vn:
            variant_names[vid] = vn["name"]

    transitions = []

    def scan(nid, current_state):
        n = nodes.get(nid)
        if not n:
            return
        raw = n["_raw"]
        for inter in raw.get("prototypeInteractions", []):
            event = inter.get("event", {})
            event_type = event.get("interactionType", "?")
            trigger_name = n["name"]
            for action in inter.get("actions", []):
                tnid_raw = action.get("transitionNodeID", {})
                tnid = f"{tnid_raw.get('sessionID', 0)}:{tnid_raw.get('localID', 0)}"
                target_name = variant_names.get(tnid)
                if target_name:
                    transitions.append({
                        "from": current_state,
                        "event": f"{event_type}({trigger_name})",
                        "to": target_name,
                    })
        for cid in n.get("children", []):
            scan(cid, current_state)

    for vid in variant_ids:
        vn = nodes.get(vid)
        if vn:
            scan(vid, vn["name"])

    return transitions

def extract_interactions(nodes, nid, indent=0):
    """Recursively find and print prototype interactions in a subtree."""
    n = nodes.get(nid)
    if not n:
        return
    raw = n["_raw"]
    interactions = raw.get("prototypeInteractions", [])
    if interactions:
        prefix = "  " * indent
        print(f"{prefix}[{n['type']}] {n['name']} ({nid})")
        for inter in interactions:
            event = inter.get("event", {})
            event_type = event.get("interactionType", "?")
            maintained = event.get("interactionMaintained", False)
            duration = event.get("interactionDuration", 0)
            event_str = event_type
            if maintained:
                event_str += f" (maintained, {duration:.1f}s)"

            actions = inter.get("actions", [])
            for action in actions:
                tnid_raw = action.get("transitionNodeID", {})
                tnid = f"{tnid_raw.get('sessionID', 0)}:{tnid_raw.get('localID', 0)}"
                target_node = nodes.get(tnid, {})
                target_name = target_node.get("name", "?") if isinstance(target_node, dict) else "?"
                nav_type = action.get("navigationType", "")
                trans_type = action.get("transitionType", "")
                trans_dur = action.get("transitionDuration", 0)
                easing = action.get("easingType", "")
                conn = action.get("connectionType", "")

                parts = [f"{prefix}  {event_str}"]
                parts.append(f"→ {nav_type or trans_type}")
                parts.append(f"to \"{target_name}\" ({tnid})")
                if trans_dur:
                    parts.append(f"[{trans_type} {trans_dur:.2f}s {easing}]")
                if conn:
                    parts.append(f"({conn})")
                print(" ".join(parts))

    for cid in n.get("children", []):
        extract_interactions(nodes, cid, indent)

def find_components(nodes, parent_map):
    """Find all SYMBOL nodes and group them by component set (parent FRAME with multiple SYMBOL children)."""
    # Build reverse map: parent -> SYMBOL children
    set_children = {}  # parent_id -> [symbol_ids]
    standalone = []     # SYMBOL nodes not in a component set

    for nid, n in nodes.items():
        if n["type"] != "SYMBOL":
            continue
        pid = parent_map.get(nid)
        if pid and nodes.get(pid, {}).get("type") == "FRAME":
            set_children.setdefault(pid, []).append(nid)
        else:
            standalone.append(nid)

    # Separate actual component sets (>1 variant) from single-variant frames
    component_sets = {}
    for pid, children in set_children.items():
        if len(children) > 1:
            component_sets[pid] = children
        else:
            standalone.extend(children)

    return component_sets, standalone

def build_parent_map(data, nodes):
    """Build child -> parent mapping."""
    parent_map = {}
    for nc in data.get("nodeChanges", []):
        g = nc.get("guid", {})
        nid = f"{g.get('sessionID', 0)}:{g.get('localID', 0)}"
        pi = nc.get("parentIndex", {})
        pg = pi.get("guid", {})
        if pg:
            pid = f"{pg.get('sessionID', 0)}:{pg.get('localID', 0)}"
            if pid != nid:
                parent_map[nid] = pid
    return parent_map

def parse_variant_props(name):
    """Parse variant property values from a SYMBOL name like 'State=Default, Size=Big'."""
    props = {}
    for part in name.split(", "):
        if "=" in part:
            k, v = part.split("=", 1)
            props[k.strip()] = v.strip()
    return props

def find_instances_of(nodes, data, component_id):
    """Find all INSTANCE nodes that reference a given component (by symbolID)."""
    # Parse component_id into sessionID:localID
    parts = component_id.split(":")
    if len(parts) != 2:
        return []
    target_sid, target_lid = int(parts[0]), int(parts[1])

    results = []
    for nc in data.get("nodeChanges", []):
        if nc.get("type") != "INSTANCE":
            continue
        sd = nc.get("symbolData", {})
        sym_id = sd.get("symbolID", {})
        if sym_id.get("sessionID") == target_sid and sym_id.get("localID") == target_lid:
            g = nc.get("guid", {})
            nid = f"{g.get('sessionID', 0)}:{g.get('localID', 0)}"
            results.append({"id": nid, "name": nc.get("name", ""), "node": nc})
    return results

def find_page_for_node(nodes, parent_map, nid):
    """Walk up the tree to find the CANVAS (page) ancestor."""
    visited = set()
    current = nid
    while current and current not in visited:
        visited.add(current)
        n = nodes.get(current)
        if n and n["type"] == "CANVAS":
            return current, n["name"]
        current = parent_map.get(current)
    return None, None


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    data = load()
    nodes = build_tree(data)

    if cmd == "pages":
        pages = find_pages(nodes)
        print(f"{'ID':<12} {'Name':<30} {'Children':>8}")
        print("-" * 55)
        for nid, n in sorted(pages.items(), key=lambda x: x[0]):
            print(f"{nid:<12} {n['name']:<30} {len(n['children']):>8}")

    elif cmd == "page":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py page <name> [--depth N]")
            sys.exit(1)
        name = sys.argv[2]
        depth = 3
        if "--depth" in sys.argv:
            depth = int(sys.argv[sys.argv.index("--depth") + 1])

        # Find page by name or ID
        target = find_by_id(nodes, name)
        if not target:
            matches = find_by_name(nodes, name)
            pages = {k: v for k, v in matches.items() if v["type"] == "CANVAS"}
            if pages:
                nid = next(iter(pages))
                target = pages[nid]
            elif matches:
                nid = next(iter(matches))
                target = matches[nid]

        if target:
            nid = target["id"]
            print(f"Page: {target['name']} ({nid})\n")
            print_tree(nodes, nid, depth)
        else:
            print(f"Page '{name}' not found")

    elif cmd == "node":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py node <name_or_id>")
            sys.exit(1)
        query = sys.argv[2]
        target = find_by_id(nodes, query)
        if not target:
            matches = find_by_name(nodes, query)
            if matches:
                target = next(iter(matches.values()))

        if target:
            nid = target["id"]
            print(f"Node: {target['name']} ({nid}) [{target['type']}]\n")
            css = extract_css(target["_raw"])
            if css:
                print("CSS properties:")
                for k, v in css.items():
                    print(f"  {k}: {v}")
                print()

            # Detect component with states (SYMBOL children = variants)
            variant_children = [cid for cid in target["children"]
                                if nodes.get(cid, {}).get("type") == "SYMBOL"]
            if variant_children:
                print("States:")
                for vc in variant_children:
                    vn = nodes[vc]
                    vis = "" if vn["visible"] else " [hidden]"
                    print(f"  {vn['name']} ({vc}){vis}")

                # Build state machine from interactions
                transitions = extract_state_machine(nodes, nid, variant_children)
                if transitions:
                    print("\nState machine:")
                    for t in transitions:
                        print(f"  {t['from']:<30} → {t['event']:<30} → {t['to']}")
                print()

            print("Tree:")
            print_tree(nodes, nid, depth=5)

            # Show interactions if any exist in subtree
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                extract_interactions(nodes, nid)
            interactions_output = buf.getvalue()
            if interactions_output:
                print("\nInteractions:")
                print(interactions_output)
        else:
            print(f"Node '{query}' not found")

    elif cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py search <pattern>")
            sys.exit(1)
        pattern = sys.argv[2]
        matches = find_by_name(nodes, pattern)
        for nid, n in list(matches.items())[:50]:
            vis = "" if n["visible"] else " [hidden]"
            print(f"[{n['type']}] {n['name']} ({nid}){vis}")

    elif cmd == "texts":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py texts <page_name>")
            sys.exit(1)
        name = sys.argv[2]
        target = find_by_id(nodes, name)
        if not target:
            matches = find_by_name(nodes, name)
            pages = {k: v for k, v in matches.items() if v["type"] == "CANVAS"}
            if pages:
                target = next(iter(pages.values()))

        if target:
            texts = extract_texts(nodes, target["id"])
            for t in texts:
                print(f"[{t['id']}] {t['name']}: {t['text'][:120]}")
        else:
            print(f"Page '{name}' not found")

    elif cmd == "css":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py css <name_or_id>")
            sys.exit(1)
        query = sys.argv[2]
        target = find_by_id(nodes, query)
        if not target:
            matches = find_by_name(nodes, query)
            if matches:
                target = next(iter(matches.values()))

        if target:
            css = extract_css(target["_raw"])
            print(json.dumps(css, indent=2))
        else:
            print(f"Node '{query}' not found")

    elif cmd == "interactions":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py interactions <name_or_id>")
            sys.exit(1)
        query = sys.argv[2]
        target = find_by_id(nodes, query)
        if not target:
            matches = find_by_name(nodes, query)
            if matches:
                target = next(iter(matches.values()))

        if target:
            extract_interactions(nodes, target["id"])
        else:
            print(f"Node '{query}' not found")

    elif cmd == "components":
        parent_map = build_parent_map(data, nodes)
        component_sets, standalone = find_components(nodes, parent_map)
        pattern = sys.argv[2] if len(sys.argv) > 2 else None
        pat = re.compile(re.escape(pattern), re.IGNORECASE) if pattern else None

        # Component sets (multi-variant)
        filtered_sets = []
        for pid, children in sorted(component_sets.items(), key=lambda x: -len(x[1])):
            pn = nodes.get(pid, {})
            pname = pn.get("name", "?")
            if pat and not pat.search(pname):
                continue
            filtered_sets.append((pid, pname, children))

        if filtered_sets:
            print(f"Component sets ({len(filtered_sets)}):\n")
            for pid, pname, children in filtered_sets:
                # Extract variant property names from first child
                first_child = nodes.get(children[0], {})
                props = parse_variant_props(first_child.get("name", ""))
                prop_names = list(props.keys())
                prop_str = f"  [{', '.join(prop_names)}]" if prop_names else ""
                print(f"  {pname} ({pid}) — {len(children)} variants{prop_str}")
                for cid in children[:4]:
                    cn = nodes.get(cid, {})
                    vis = "" if cn.get("visible", True) else " [hidden]"
                    print(f"    [{cn.get('type', '?')}] {cn.get('name', '?')} ({cid}){vis}")
                if len(children) > 4:
                    print(f"    ... +{len(children)-4} more")
                print()

        # Standalone components
        filtered_standalone = []
        for nid in standalone:
            n = nodes.get(nid, {})
            name = n.get("name", "")
            if pat and not pat.search(name):
                continue
            filtered_standalone.append((nid, n))

        if filtered_standalone:
            print(f"Standalone components ({len(filtered_standalone)}):\n")
            for nid, n in filtered_standalone:
                pub = " [published]" if n["_raw"].get("isSymbolPublishable") else ""
                print(f"  {n['name']} ({nid}){pub}")

        if not filtered_sets and not filtered_standalone:
            print("No components found" + (f" matching '{pattern}'" if pattern else ""))

    elif cmd == "component":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py component <name_or_id>")
            sys.exit(1)
        query = sys.argv[2]
        parent_map = build_parent_map(data, nodes)

        # Try to find the target: could be a component set (FRAME) or a single SYMBOL
        target = find_by_id(nodes, query)
        if not target:
            matches = find_by_name(nodes, query)
            # Score matches: exact name > starts-with > contains; component set > symbol > other
            def match_score(nid_n):
                nid, n = nid_n
                name_lower = n["name"].lower()
                query_lower = query.lower()
                # Name match quality
                if name_lower == query_lower:
                    name_score = 3
                elif name_lower.startswith(query_lower):
                    name_score = 2
                else:
                    name_score = 1
                # Type priority
                if n["type"] == "FRAME" and any(
                    nodes.get(cid, {}).get("type") == "SYMBOL" for cid in n["children"]
                ):
                    type_score = 3  # component set
                elif n["type"] == "SYMBOL":
                    type_score = 2  # standalone component
                else:
                    type_score = 0
                return (name_score, type_score)

            ranked = sorted(matches.items(), key=match_score, reverse=True)
            if ranked:
                best_nid, best_n = ranked[0]
                # Only accept if it's a component-like node
                score = match_score((best_nid, best_n))
                if score[1] > 0:
                    target = best_n
                elif ranked:
                    target = best_n

        if not target:
            print(f"Component '{query}' not found")
            sys.exit(1)

        nid = target["id"]
        raw = target["_raw"]

        # Determine if this is a component set or a single component
        variant_children = [cid for cid in target["children"]
                            if nodes.get(cid, {}).get("type") == "SYMBOL"]

        if variant_children:
            # Component set
            print(f"Component set: {target['name']} ({nid})\n")

            # Extract variant property names
            all_props = {}
            for vcid in variant_children:
                vn = nodes.get(vcid, {})
                props = parse_variant_props(vn.get("name", ""))
                for k, v in props.items():
                    all_props.setdefault(k, set()).add(v)

            if all_props:
                print("Variant properties:")
                for prop_name, values in all_props.items():
                    print(f"  {prop_name}: {', '.join(sorted(values))}")
                print()

            # List variants
            print(f"Variants ({len(variant_children)}):")
            for vcid in variant_children:
                vn = nodes.get(vcid, {})
                vis = "" if vn.get("visible", True) else " [hidden]"
                size = vn["_raw"].get("size", {})
                dim = f" ({size.get('x', 0):.0f}x{size.get('y', 0):.0f})" if size else ""
                print(f"  {vn['name']} ({vcid}){vis}{dim}")
            print()

            # State machine
            transitions = extract_state_machine(nodes, nid, variant_children)
            if transitions:
                print("State machine:")
                for t in transitions:
                    print(f"  {t['from']:<30} → {t['event']:<30} → {t['to']}")
                print()

            # Show tree of first visible variant
            first_visible = None
            for vcid in variant_children:
                vn = nodes.get(vcid, {})
                if vn.get("visible", True):
                    first_visible = vcid
                    break
            if first_visible:
                vn = nodes.get(first_visible, {})
                print(f"Tree (first variant: {vn['name']}):")
                print_tree(nodes, first_visible, depth=4)

        else:
            # Single component
            print(f"Component: {target['name']} ({nid}) [{target['type']}]\n")

            # Component properties
            comp_props = raw.get("componentPropDefs", [])
            if comp_props:
                print("Component properties:")
                for prop in comp_props:
                    ptype = prop.get("type", "?")
                    pname = prop.get("name", "?")
                    print(f"  {pname} ({ptype})")
                print()

            pub = raw.get("isSymbolPublishable")
            key = raw.get("componentKey", "")
            if pub is not None or key:
                meta = []
                if pub:
                    meta.append("published")
                if key:
                    meta.append(f"key={key[:20]}...")
                print(f"Meta: {', '.join(meta)}\n")

            # CSS
            css = extract_css(raw)
            if css:
                print("CSS:")
                for k, v in css.items():
                    print(f"  {k}: {v}")
                print()

            # Page location
            page_id, page_name = find_page_for_node(nodes, parent_map, nid)
            if page_name:
                print(f"Page: {page_name} ({page_id})\n")

            # Tree
            print("Tree:")
            print_tree(nodes, nid, depth=4)

        # Find instances
        instances = find_instances_of(nodes, data, nid)
        # Also check instances of variant children
        for vcid in variant_children if variant_children else []:
            instances.extend(find_instances_of(nodes, data, vcid))

        if instances:
            print(f"\nInstances ({len(instances)}):")
            for inst in instances[:20]:
                page_id, page_name = find_page_for_node(nodes, parent_map, inst["id"])
                page_str = f" in {page_name}" if page_name else ""
                print(f"  {inst['name']} ({inst['id']}){page_str}")
            if len(instances) > 20:
                print(f"  ... +{len(instances)-20} more")

    elif cmd == "instances":
        if len(sys.argv) < 3:
            print("Usage: figma_local.py instances <name_or_id>")
            sys.exit(1)
        query = sys.argv[2]
        parent_map = build_parent_map(data, nodes)

        # Find the component
        target = find_by_id(nodes, query)
        if not target:
            matches = find_by_name(nodes, query)
            for nid, n in matches.items():
                if n["type"] in ("SYMBOL", "FRAME"):
                    target = n
                    break

        if not target:
            print(f"Component '{query}' not found")
            sys.exit(1)

        nid = target["id"]

        # Collect all SYMBOL IDs to search (the component itself + its variant children)
        search_ids = [nid]
        variant_children = [cid for cid in target["children"]
                            if nodes.get(cid, {}).get("type") == "SYMBOL"]
        search_ids.extend(variant_children)

        all_instances = []
        for sid in search_ids:
            all_instances.extend(find_instances_of(nodes, data, sid))

        if all_instances:
            # Group by page
            by_page = {}
            for inst in all_instances:
                page_id, page_name = find_page_for_node(nodes, parent_map, inst["id"])
                key = page_name or "(unknown)"
                by_page.setdefault(key, []).append(inst)

            print(f"Instances of '{target['name']}' ({len(all_instances)} total):\n")
            for page_name, insts in sorted(by_page.items()):
                print(f"  {page_name} ({len(insts)}):")
                for inst in insts:
                    overrides = len(inst["node"].get("symbolData", {}).get("symbolOverrides", []))
                    ov_str = f" [{overrides} overrides]" if overrides else ""
                    print(f"    {inst['name']} ({inst['id']}){ov_str}")
                print()
        else:
            print(f"No instances found for '{target['name']}'")

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)

if __name__ == "__main__":
    main()
