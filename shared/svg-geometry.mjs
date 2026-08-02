const SHAPE_TAGS = new Set(["path", "polygon", "polyline", "rect", "circle", "ellipse", "line"]);
const NUMBER_PATTERN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

function numbers(value) {
  return (String(value).match(NUMBER_PATTERN) ?? []).map(Number);
}

function attribute(attrs, name) {
  const match = String(attrs).match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function requiredNumbers(value, count, context) {
  const values = numbers(value);
  if (values.length !== count || values.some((number) => !Number.isFinite(number))) {
    throw new Error(`${context} must contain ${count} finite numbers`);
  }
  return values;
}

export function parseSvgViewBox(svg) {
  const root = String(svg).match(/<svg\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i);
  if (!root) throw new Error("SVG document has no root element");
  const raw = attribute(root[1], "viewBox");
  if (raw === null) throw new Error("SVG root is missing viewBox");
  const [x, y, width, height] = requiredNumbers(raw, 4, "SVG viewBox");
  if (width <= 0 || height <= 0) throw new Error("SVG viewBox width and height must be positive");
  return { x, y, width, height };
}

function pathArguments(code, args, stride, minimum = stride) {
  if (args.length < minimum || args.length % stride !== 0) {
    throw new Error(`SVG path command ${code} has an invalid argument count`);
  }
}

function parsePath(value) {
  const subPaths = [];
  let approximated = false;
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  const chunks = String(value).match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!chunks?.length) throw new Error("SVG path contains no supported commands");

  const open = () => {
    current = { points: [], closed: false };
    subPaths.push(current);
  };
  const push = (nextX, nextY) => {
    if (!current) open();
    x = nextX;
    y = nextY;
    current.points.push([nextX, nextY]);
  };

  for (const chunk of chunks) {
    const code = chunk[0];
    const upper = code.toUpperCase();
    const relative = code === code.toLowerCase();
    const args = numbers(chunk.slice(1));
    if (args.some((number) => !Number.isFinite(number))) {
      throw new Error(`SVG path command ${code} contains a non-finite number`);
    }
    if (upper === "M") {
      pathArguments(code, args, 2);
      for (let index = 0; index < args.length; index += 2) {
        const nextX = relative ? x + args[index] : args[index];
        const nextY = relative ? y + args[index + 1] : args[index + 1];
        if (index === 0) {
          open();
          startX = nextX;
          startY = nextY;
        }
        push(nextX, nextY);
      }
      continue;
    }
    if (upper === "L") {
      pathArguments(code, args, 2);
      for (let index = 0; index < args.length; index += 2) {
        push(relative ? x + args[index] : args[index], relative ? y + args[index + 1] : args[index + 1]);
      }
      continue;
    }
    if (upper === "H" || upper === "V") {
      pathArguments(code, args, 1);
      for (const arg of args) {
        if (upper === "H") push(relative ? x + arg : arg, y);
        else push(x, relative ? y + arg : arg);
      }
      continue;
    }
    if (["C", "S", "Q", "T", "A"].includes(upper)) {
      const stride = { C: 6, S: 4, Q: 4, T: 2, A: 7 }[upper];
      pathArguments(code, args, stride);
      for (let index = 0; index < args.length; index += stride) {
        const endpointX = args[index + stride - 2];
        const endpointY = args[index + stride - 1];
        push(relative ? x + endpointX : endpointX, relative ? y + endpointY : endpointY);
      }
      approximated = true;
      continue;
    }
    if (upper === "Z") {
      if (args.length) throw new Error("SVG path close command cannot have arguments");
      if (!current) throw new Error("SVG path closes before opening a subpath");
      current.closed = true;
      x = startX;
      y = startY;
      current = null;
    }
  }
  return { subPaths, approximated };
}

function finiteAttribute(attrs, name, defaultValue) {
  const raw = attribute(attrs, name);
  if (raw === null && defaultValue !== undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`SVG ${name} must be finite`);
  return value;
}

function parseShape(tag, attrs) {
  if (tag === "path") {
    const value = attribute(attrs, "d");
    if (!value) throw new Error("SVG path is missing d");
    return parsePath(value);
  }
  if (tag === "polygon" || tag === "polyline") {
    const raw = attribute(attrs, "points");
    if (raw === null) throw new Error(`SVG ${tag} is missing points`);
    const values = numbers(raw);
    const minimum = tag === "polygon" ? 6 : 4;
    if (values.length < minimum || values.length % 2 !== 0 || values.some((number) => !Number.isFinite(number))) {
      throw new Error(`SVG ${tag} has invalid points`);
    }
    const points = [];
    for (let index = 0; index < values.length; index += 2) points.push([values[index], values[index + 1]]);
    return { subPaths: [{ points, closed: tag === "polygon" }], approximated: false };
  }
  if (tag === "rect") {
    const x = finiteAttribute(attrs, "x", 0);
    const y = finiteAttribute(attrs, "y", 0);
    const width = finiteAttribute(attrs, "width");
    const height = finiteAttribute(attrs, "height");
    if (width <= 0 || height <= 0) throw new Error("SVG rect width and height must be positive");
    return {
      subPaths: [{ points: [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed: true }],
      approximated: false,
    };
  }
  if (tag === "line") {
    const x1 = finiteAttribute(attrs, "x1");
    const y1 = finiteAttribute(attrs, "y1");
    const x2 = finiteAttribute(attrs, "x2");
    const y2 = finiteAttribute(attrs, "y2");
    return { subPaths: [{ points: [[x1, y1], [x2, y2]], closed: false }], approximated: false };
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = finiteAttribute(attrs, "cx", 0);
    const cy = finiteAttribute(attrs, "cy", 0);
    const rx = finiteAttribute(attrs, tag === "circle" ? "r" : "rx");
    const ry = tag === "circle" ? rx : finiteAttribute(attrs, "ry");
    if (rx <= 0 || ry <= 0) throw new Error(`SVG ${tag} radii must be positive`);
    return {
      subPaths: [{ points: [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]], closed: true }],
      approximated: true,
    };
  }
  throw new Error(`Unsupported SVG shape ${tag}`);
}

function closeRing(points) {
  const first = points[0];
  const last = points[points.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? points : [...points, first];
}

function ringArea(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    sum += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return Math.abs(sum / 2);
}

function onSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-9) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-9
    && point[0] <= Math.max(start[0], end[0]) + 1e-9
    && point[1] >= Math.min(start[1], end[1]) - 1e-9
    && point[1] <= Math.max(start[1], end[1]) + 1e-9;
}

function ringContains(ring, point) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const start = ring[previous];
    const end = ring[index];
    if (onSegment(point, start, end)) return true;
    if ((end[1] > point[1]) !== (start[1] > point[1])) {
      const crossingX = ((start[0] - end[0]) * (point[1] - end[1])) / (start[1] - end[1]) + end[0];
      if (point[0] < crossingX) inside = !inside;
    }
  }
  return inside;
}

function polygonGeometry(subPaths) {
  const nodes = subPaths
    .filter((subPath) => subPath.closed && subPath.points.length >= 3)
    .map((subPath, order) => {
      const ring = closeRing(subPath.points);
      return { ring, order, area: ringArea(ring), parent: -1, depth: 0 };
    });
  for (let index = 0; index < nodes.length; index += 1) {
    let parent = -1;
    for (let candidate = 0; candidate < nodes.length; candidate += 1) {
      if (candidate === index || nodes[candidate].area <= nodes[index].area) continue;
      if (!ringContains(nodes[candidate].ring, nodes[index].ring[0])) continue;
      if (parent === -1 || nodes[candidate].area < nodes[parent].area) parent = candidate;
    }
    nodes[index].parent = parent;
  }
  const depthOf = (index) => {
    const parent = nodes[index].parent;
    if (parent === -1) return 0;
    return depthOf(parent) + 1;
  };
  for (let index = 0; index < nodes.length; index += 1) nodes[index].depth = depthOf(index);

  const polygons = nodes
    .filter((node) => node.depth % 2 === 0)
    .sort((left, right) => left.order - right.order)
    .map((shell) => [
      shell.ring,
      ...nodes
        .filter((node) => node.parent === nodes.indexOf(shell) && node.depth === shell.depth + 1)
        .sort((left, right) => left.order - right.order)
        .map((node) => node.ring),
    ]);
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
  return { type: "MultiPolygon", coordinates: polygons };
}

function geometryOf(subPaths) {
  const polygon = polygonGeometry(subPaths);
  const lines = subPaths
    .filter((subPath) => !subPath.closed && subPath.points.length >= 2)
    .map((subPath) => subPath.points);
  if (polygon && lines.length === 0) return polygon;
  if (!polygon && lines.length === 1) return { type: "LineString", coordinates: lines[0] };
  if (!polygon && lines.length > 1) return { type: "MultiLineString", coordinates: lines };
  if (!polygon && lines.length === 0) return null;
  return {
    type: "GeometryCollection",
    geometries: [
      polygon,
      { type: lines.length === 1 ? "LineString" : "MultiLineString", coordinates: lines.length === 1 ? lines[0] : lines },
    ],
  };
}

function bboxOf(subPaths) {
  const points = subPaths.flatMap((subPath) => subPath.points);
  if (!points.length) return null;
  const x = points.map((point) => point[0]);
  const y = points.map((point) => point[1]);
  return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)];
}

function textContent(value) {
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function stableKey(sourceElementId) {
  const key = sourceElementId.normalize("NFKC").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return key || null;
}

export function parseSvgFeatures(svg) {
  parseSvgViewBox(svg);
  const features = [];
  const stack = [];
  const seenIds = new Set();
  let order = 0;
  const push = (sourceElementId, featureOrder, subPaths, approximated, label) => {
    if (seenIds.has(sourceElementId)) throw new Error(`Duplicate SVG element id: ${sourceElementId}`);
    seenIds.add(sourceElementId);
    features.push({
      order: featureOrder,
      sourceElementId,
      stableKey: stableKey(sourceElementId),
      geometry: geometryOf(subPaths),
      bbox: bboxOf(subPaths),
      approximated,
      label,
    });
  };

  const source = String(svg);
  const tagPattern = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(source)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";
    const selfClosing = match[4] === "/";
    if (tag === "g") {
      if (closing) {
        const frame = stack.pop();
        if (!frame) throw new Error("SVG group closing tag has no opening tag");
        if (frame.sourceElementId) {
          const label = frame.labels.join(" ").replace(/\s+/g, " ").trim();
          push(frame.sourceElementId, frame.order, frame.subPaths, frame.approximated, label ? label.slice(0, 200) : null);
        }
      } else if (!selfClosing) {
        const sourceElementId = attribute(attrs, "id");
        stack.push({
          sourceElementId,
          order: sourceElementId ? order++ : -1,
          subPaths: [],
          approximated: false,
          labels: [],
        });
      }
      continue;
    }
    if (tag === "text" && !closing && !selfClosing) {
      const end = source.indexOf("</text>", tagPattern.lastIndex);
      if (end === -1) throw new Error("SVG text element is not closed");
      const label = textContent(source.slice(tagPattern.lastIndex, end));
      if (label) for (const frame of stack) frame.labels.push(label);
      tagPattern.lastIndex = end + "</text>".length;
      continue;
    }
    if (closing || !SHAPE_TAGS.has(tag)) continue;
    const sourceElementId = attribute(attrs, "id");
    if (!sourceElementId && stack.length === 0) continue;
    const shape = parseShape(tag, attrs);
    for (const frame of stack) {
      frame.subPaths.push(...shape.subPaths);
      frame.approximated ||= shape.approximated;
    }
    if (sourceElementId) push(sourceElementId, order++, shape.subPaths, shape.approximated, null);
  }
  if (stack.length) throw new Error("SVG group is not closed");
  return features.sort((left, right) => left.order - right.order);
}
