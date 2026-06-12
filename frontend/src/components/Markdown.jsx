/**
 * Markdown.jsx — a small, zero-dependency markdown renderer.
 *
 * Scoped to the subset the Quant Researcher emits: headings, paragraphs,
 * blockquotes, unordered lists, fenced code blocks, GFM tables, horizontal
 * rules, and inline **bold** / _italic_ / `code` / [links](url). It builds
 * real React nodes (no dangerouslySetInnerHTML) so AI-generated text can't
 * inject markup. Styling uses the app's Tailwind theme tokens.
 */

// --- inline: **bold**, _italic_/*italic*, `code`, [text](url) ---------------
function renderInline(text, keyPrefix = "i") {
  const nodes = [];
  // Order matters: code first (so its contents aren't re-parsed), then links,
  // then bold, then italic.
  const re = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(_[^_]+_)|(\*[^*]+\*)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={key} className="px-1 py-0.5 rounded bg-bg-elev text-accent-cyan text-[0.85em] font-mono">
          {tok.slice(1, -1)}
        </code>
      );
    } else if (tok.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      nodes.push(
        <a key={key} href={mm[2]} className="text-accent-blue hover:underline" target="_blank" rel="noreferrer">
          {mm[1]}
        </a>
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={key} className="text-text font-semibold">{tok.slice(2, -2)}</strong>);
    } else {
      // _italic_ or *italic*
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line) {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export default function Markdown({ source = "", className = "" }) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++; // skip closing fence
      blocks.push(
        <pre key={k++} className="my-3 p-3 rounded-lg border border-line bg-bg-deep/60 overflow-x-auto text-xs font-mono text-text/90 whitespace-pre">
          {buf.join("\n")}
        </pre>
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*---\s*$/.test(line)) {
      blocks.push(<hr key={k++} className="my-4 border-line" />);
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = {
        1: "text-2xl font-semibold tracking-tight mt-2 mb-3",
        2: "text-lg font-semibold tracking-tight mt-5 mb-2 text-text",
        3: "text-base font-semibold mt-4 mb-1.5 text-text",
        4: "text-sm font-semibold mt-3 mb-1 text-muted uppercase tracking-wider",
      }[level];
      const Tag = `h${level}`;
      blocks.push(<Tag key={k++} className={cls}>{renderInline(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={k++} className="my-3 pl-3 border-l-2 border-accent-violet/60 text-sm text-muted italic">
          {renderInline(buf.join(" "), `q${k}`)}
        </blockquote>
      );
      continue;
    }

    // GFM table: header row + separator row of dashes
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      i += 2; // skip header + separator
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i++]));
      }
      blocks.push(
        <div key={k++} className="my-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted bg-bg-elev/40">
              <tr>{header.map((c, ci) => <th key={ci} className="text-left px-3 py-2 font-medium">{renderInline(c, `th${k}-${ci}`)}</th>)}</tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r, ri) => (
                <tr key={ri} className="border-t border-line/60">
                  {r.map((c, ci) => <td key={ci} className="px-3 py-1.5 align-top">{renderInline(c, `td${k}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      }
      blocks.push(
        <ul key={k++} className="my-2 ml-1 space-y-1 text-sm text-text/90">
          {items.map((it, ii) => (
            <li key={ii} className="flex gap-2">
              <span className="text-accent-violet mt-0.5">•</span>
              <span>{renderInline(it, `li${k}-${ii}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-blank, non-special lines)
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4})\s/.test(lines[i]) &&
      !/^```/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*---\s*$/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    blocks.push(
      <p key={k++} className="my-2 text-sm leading-relaxed text-text/90">
        {renderInline(buf.join(" "), `p${k}`)}
      </p>
    );
  }

  return <div className={className}>{blocks}</div>;
}
