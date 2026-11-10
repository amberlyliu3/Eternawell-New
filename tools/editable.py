"""Marks the text and photos in built pages so the admin editor can change them.

Usage: python3 tools/editable.py site/v8

Adds data-edit="<scope>:<id>" to each block of text (headings, paragraphs, list items, ...)
and data-edit-img="<scope>:img-<id>" to each photo (the <img>, or the empty placeholder figure).
Ids come from a hash of the original text, so they stay the same when other parts of a page change.
Text in the footer and the booking call-to-action is shared across pages (scope "shared").
"""
import hashlib
import pathlib
import re
import sys
from html.parser import HTMLParser

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
BLOCKS = {'h1', 'h2', 'h3', 'h4', 'p', 'blockquote', 'summary', 'dt', 'dd', 'li'}
INLINE = {'span', 'b', 'strong'}  # editable on their own only when they sit directly in a layout element
NOT_INSIDE = {'svg', 'img', 'form', 'input', 'button', 'figure', 'ul', 'ol', 'div', 'nav', 'iframe', 'select', 'textarea', 'script', 'style', 'dl', 'section', 'article', 'p', 'h1', 'h2', 'h3'}
SKIP_ANCESTOR_TAGS = {'header', 'nav', 'form', 'script', 'style', 'svg', 'noscript', 'button', 'figcaption'}
SKIP_ANCESTOR_CLASSES = {'rail', 'legal-row', 'legal-toc', 'links', 'wordmark', 'skip', 'booking', 'visually-hidden'}
SKIP_CLASSES = {'num', 'n', 'arr', 'visually-hidden', 'logo-sub', 'ph-label', 'wordmark', 'foot-logo'}


class Node:
    def __init__(self, tag, attrs, start, open_end, parent):
        self.tag, self.attrs, self.start, self.open_end, self.parent = tag, dict(attrs), start, open_end, parent
        self.close_start = self.end = open_end
        self.children = []

    @property
    def classes(self):
        return set((self.attrs.get('class') or '').split())

    def ancestors(self):
        n = self.parent
        while n is not None:
            yield n
            n = n.parent

    def walk(self):
        for c in self.children:
            yield c
            yield from c.walk()


class Tree(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.lines = [0]
        for m in re.finditer('\n', text):
            self.lines.append(m.end())
        self.root = Node('#root', [], 0, 0, None)
        self.stack = [self.root]
        self.feed(text)
        self.close()

    def here(self):
        line, col = self.getpos()
        return self.lines[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self.here()
        node = Node(tag, attrs, start, start + len(self.get_starttag_text()), self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        start = self.here()
        self.stack[-1].children.append(Node(tag, attrs, start, start + len(self.get_starttag_text()), self.stack[-1]))

    def handle_endtag(self, tag):
        if not any(n.tag == tag for n in self.stack[1:]):
            return
        start = self.here()
        end = self.text.index('>', start) + 1
        while self.stack[-1].tag != tag:
            n = self.stack.pop()
            n.close_start = n.end = start
        n = self.stack.pop()
        n.close_start, n.end = start, end


def inner_text(text, node):
    s = re.sub(r'<[^>]+>', '', text[node.open_end:node.close_start])
    return re.sub(r'\s+', ' ', s).strip()


def skipped(node):
    for a in node.ancestors():
        if a.tag in SKIP_ANCESTOR_TAGS or a.classes & SKIP_ANCESTOR_CLASSES:
            return True
    return bool(node.classes & SKIP_CLASSES)


def candidate(node):
    if node.tag in BLOCKS:
        return True
    return node.tag in INLINE and node.parent is not None and node.parent.tag not in BLOCKS and node.parent.tag not in INLINE


def scope_of(node, page):
    for a in node.ancestors():
        if a.tag == 'footer' or 'cta-sec' in a.classes:
            return 'shared'
    return page


def mark(path, page):
    text = path.read_text()
    tree = Tree(text)
    inserts = []  # (offset, attribute text)
    seen = {}

    def key_for(scope, prefix, basis):
        h = hashlib.sha1(basis.encode()).hexdigest()[:10]
        k = f'{scope}:{prefix}{h}'
        n = seen.get(k, 0)
        seen[k] = n + 1
        return k if n == 0 else f'{k}-{n}'

    body = next((n for n in tree.root.walk() if n.tag == 'body'), tree.root)
    for node in body.walk():
        if 'data-edit' in node.attrs or not candidate(node) or skipped(node):
            continue
        if any(candidate(d) and not skipped(d) for d in node.walk()):
            continue  # its children are editable instead
        if any(d.tag in NOT_INSIDE for d in node.walk()):
            continue
        words = inner_text(text, node)
        if not words:
            continue
        key = key_for(scope_of(node, page), '', words)
        inserts.append((node.open_end - (2 if text[node.open_end - 2] == '/' else 1), f' data-edit="{key}"'))

    for fig in body.walk():
        if fig.tag != 'figure' or 'ph' not in fig.classes or 'preview' in fig.classes:
            continue
        cap = next((c for c in fig.children if c.tag == 'figcaption'), None)
        label = inner_text(text, cap) if cap else ''
        key = key_for(scope_of(fig, page), 'img-', label)
        img = next((c for c in fig.children if c.tag == 'img'), None)
        target = img or fig
        end = target.open_end - (2 if text[target.open_end - 2] == '/' else 1)
        inserts.append((end, f' data-edit-img="{key}"'))

    for offset, attr in sorted(inserts, reverse=True):
        text = text[:offset] + attr + text[offset:]
    path.write_text(text)
    return len(inserts)


def main(out_dir):
    out = pathlib.Path(out_dir)
    total = 0
    for f in sorted(out.rglob('index.html')):
        rel = f.parent.relative_to(out)
        page = 'home' if str(rel) == '.' else str(rel).replace('/', '-')
        total += mark(f, page)
    print(f'marked {total} editable items in {out_dir}')


if __name__ == '__main__':
    main(sys.argv[1])
