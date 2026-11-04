"""Rules a team adds for its own data: an employee ID format, a member-number column. They are found like the
built-in types and masked as ``[<LABEL>_1]``, so ``unmask`` restores them like any other placeholder."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Optional, Union

from .. import _js
from .types import PII_TYPES, PiiMatch

_LABEL = re.compile(r'[A-Z][A-Z_]*[A-Z]|[A-Z]')


@dataclass(slots=True, frozen=True)
class CustomRule:
    """A team's own rule.

    ``label`` names the placeholder, in capitals and underscores: ``EMPLOYEE_ID`` masks as ``[EMPLOYEE_ID_1]``.
    ``pattern`` finds values wherever they appear. A string is a regular expression in JavaScript syntax, as written
    in ``.samaran.json``, so both ports match the same text; keep to syntax JavaScript and Python share (no
    lookbehind, no named groups). A compiled ``re.Pattern`` is used as it is.
    ``fields`` names fields whose values are this data: JSON keys, ``key: value`` and ``key=value`` labels, and CSV
    or TSV columns, matched without regard to case.
    """

    label: str
    pattern: Optional[Union[str, re.Pattern[str]]] = None
    fields: Sequence[str] = ()


RuleLike = Union[CustomRule, Mapping[str, Any]]


def to_rules(rules: Iterable[RuleLike]) -> tuple[CustomRule, ...]:
    """Rules as ``CustomRule``, from instances or dicts like ``{"label": ..., "pattern": ...}``, checked."""
    out = tuple(
        r if isinstance(r, CustomRule)
        else CustomRule(r.get('label', ''), r.get('pattern'), tuple(r.get('fields') or ()))
        for r in rules
    )
    check_custom_rules(out)
    return out


def check_custom_rules(rules: Iterable[CustomRule]) -> None:
    """Raises ValueError for a rule that cannot work: a bad label, a pattern that does not compile, nothing to match."""
    for rule in rules:
        if not isinstance(rule.label, str) or not _LABEL.fullmatch(rule.label):
            raise ValueError(
                f'Custom rule label "{rule.label}" must be capital letters and underscores, like EMPLOYEE_ID.'
            )
        if rule.label in PII_TYPES:
            raise ValueError(f'Custom rule label "{rule.label}" is a built-in type; choose another name.')
        if rule.pattern is None and not rule.fields:
            raise ValueError(f'Custom rule {rule.label} needs a pattern or fields.')
        if isinstance(rule.pattern, str):
            try:
                _js.rx(rule.pattern)
            except (re.error, IndexError) as e:
                raise ValueError(f'Custom rule {rule.label}: pattern does not compile ({e}).') from None
        source = rule.pattern.pattern if isinstance(rule.pattern, re.Pattern) else rule.pattern
        if source is not None and len(source) > _MAX_PATTERN:
            raise ValueError(f'Custom rule {rule.label}: pattern is longer than {_MAX_PATTERN} characters.')
        if source is not None and nested_quantifier(source):
            raise ValueError(
                f'Custom rule {rule.label}: a repeated group that repeats inside, like (a+)+, can take exponential '
                'time on some text and stop the guard; write it without the nesting.'
            )


_MAX_PATTERN = 1000
_COUNTED = re.compile(r'\{\d*,\d*\}|\{\d+\}')
_ONCE = re.compile(r'\{[01]\}')
_OPEN_RANGE = re.compile(r'\{\d*,')


def nested_quantifier(source: str) -> bool:
    """Whether a pattern repeats a group that itself holds a repetition: (a+)+, (\\w*)*, (x+){2,}. Those can
    backtrack for minutes on a line that almost matches, and a guard past its hook's time limit lets a call through."""
    inner: list[bool] = []
    i = 0
    while i < len(source):
        c = source[i]
        if c == '\\':
            i += 1
        elif c == '[':
            # A character class: skip to its end.
            i += 1
            while i < len(source) and source[i] != ']':
                if source[i] == '\\':
                    i += 1
                i += 1
        elif c == '(':
            inner.append(False)
        elif c == ')':
            repeated = inner.pop() if inner else False
            # A repetition inside counts for the group around this one too.
            if repeated and inner:
                inner[-1] = True
            rest = source[i + 1 :]
            counted = rest[:1] == '{' and bool(_COUNTED.match(rest)) and not _ONCE.match(rest)
            if repeated and (rest[:1] in ('*', '+') or counted):
                return True
        elif inner and (c in '*+' or (c == '{' and _OPEN_RANGE.match(source[i:]))):
            inner[-1] = True
        i += 1
    return False


def _custom(label: str, start: int, value: str) -> PiiMatch:
    return PiiMatch('CUSTOM', start, start + len(value), value, 'high', label)


def _by_pattern(text: str, rule: CustomRule) -> list[PiiMatch]:
    pattern = _js.rx(rule.pattern) if isinstance(rule.pattern, str) else rule.pattern
    assert pattern is not None
    return [_custom(rule.label, m.start(), m.group(0)) for m in pattern.finditer(text) if m.group(0)]


_WORDS = re.compile(f'({_js.WS}+)')
_WORD_START = re.compile(r'[A-Z0-9]')


def _by_label(text: str, rule: CustomRule, names: str) -> list[PiiMatch]:
    """``"no_member": "M-0042"``, ``no_member: M-0042``, ``no_member=M-0042``."""
    pattern = _js.rx(
        f'(?:^|[^A-Za-z0-9_])(["\']?)(?:{names})\\1[ \\t]*[:=][ \\t]*'
        f'(?:"([^"\\r\\n]*)"|\'([^\'\\r\\n]*)\'|([^\\s,;}}\\]"\'][^,;}}\\]\\r\\n]*))',
        'i',
    )
    out: list[PiiMatch] = []
    for m in pattern.finditer(text):
        quoted = m.group(2) if m.group(2) is not None else m.group(3)
        if quoted is not None:
            if _js.trim(quoted):
                out.append(_custom(rule.label, m.end() - 1 - len(quoted), quoted))
            continue
        # Unquoted, the value runs on while words look like part of it ("Siti Aminah", "M 0042"), not into a sentence.
        raw = m.group(4)
        words = _WORDS.split(raw)
        value = words[0]
        i = 1
        while i + 1 < len(words) and i < 12 and _WORD_START.match(words[i + 1]):
            value += words[i] + words[i + 1]
            i += 2
        out.append(_custom(rule.label, m.end() - len(raw), value))
    return out


def _cells(line: str, delimiter: str) -> list[tuple[int, str]]:
    """One CSV/TSV line as cells with their offsets, honoring double quotes."""
    out: list[tuple[int, str]] = []
    i = 0
    while True:
        start = i
        if i < len(line) and line[i] == '"':
            j = i + 1
            while j < len(line) and not (line[j] == '"' and line[j + 1 : j + 2] != '"'):
                j += 2 if line[j] == '"' else 1
            start, end = i + 1, j
            i = j + 1
            while i < len(line) and line[i] != delimiter:
                i += 1
        else:
            end = line.find(delimiter, i)
            if end == -1:
                end = len(line)
            i = end
        out.append((start, line[start:end]))
        if i >= len(line):
            return out
        i += 1


def _by_column(text: str, rule: CustomRule, wanted: frozenset[str]) -> list[PiiMatch]:
    """A column of a CSV or TSV whose header names the field, down to the first blank line."""
    out: list[PiiMatch] = []
    columns: Optional[list[int]] = None
    delimiter = ','
    width = 0
    pos = 0
    while pos <= len(text):
        end = text.find('\n', pos)
        if end == -1:
            end = len(text)
        line = text[pos:end]
        if line.endswith('\r'):
            line = line[:-1]
        if not _js.trim(line):
            columns = None
        elif columns is not None:
            row = _cells(line, delimiter)
            if len(row) == width:
                for c in columns:
                    start, cell = row[c]
                    value = _js.trim(cell)
                    if value:
                        out.append(_custom(rule.label, pos + start + cell.find(value), value))
        else:
            for d in (',', '\t', ';', '|'):
                header = _cells(line, d)
                if len(header) < 2:
                    continue
                hit = [i for i, (_, cell) in enumerate(header) if _js.trim(cell).lower() in wanted]
                if hit:
                    columns, delimiter, width = hit, d, len(header)
                    break
        pos = end + 1
    return out


def detect_custom(text: str, rules: Sequence[CustomRule]) -> list[PiiMatch]:
    """Everything the rules find, possibly overlapping; detect_pii picks among them and the built-in matches."""
    out: list[PiiMatch] = []
    for rule in rules:
        if rule.pattern is not None:
            out.extend(_by_pattern(text, rule))
        if rule.fields:
            out.extend(_by_label(text, rule, '|'.join(re.escape(f) for f in rule.fields)))
            out.extend(_by_column(text, rule, frozenset(f.lower() for f in rule.fields)))
    return out
