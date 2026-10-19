"""Reject concrete identity facts absent from the customer's instruction and conversation."""
import re


PATTERNS = {
    'email': re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.I),
    'order_id': re.compile(r'\bW\d{6,}\b', re.I),
    'numeric_id': re.compile(r'\b\d{10}\b'),
    'address': re.compile(r"\b\d{1,6}\s+(?:[A-Z][A-Z'-]*\s+){0,4}(?:Street|St|Drive|Dr|Avenue|Ave|Road|Rd|Lane|Ln|Boulevard|Blvd|Way|Court|Ct|Place|Pl|Parkway|Pkwy|West|East|North|South)\b", re.I),
    'zip': re.compile(r'\b(?:zip(?:\s+code)?|postal(?:\s+code)?)\s*(?:is\s+)?[:=]?\s*(\d{5}(?:-\d{4})?)\b', re.I),
}


def ungrounded_facts(candidate, instruction, messages):
    # Accepted history only: never treat the rejected candidate or reviewer repair as evidence.
    source = instruction + '\n' + '\n'.join(m.get('content', '') for m in messages if m.get('role') != 'system')
    normalized_source = re.sub(r'\s+', ' ', source).lower()
    unknown = []
    for kind, pattern in PATTERNS.items():
        values = lambda text: {re.sub(r'\s+', ' ', x).lower() for x in pattern.findall(text)}
        for value in sorted(values(candidate)):
            if not re.search(r'(?<!\w)' + re.escape(value) + r'(?!\w)', normalized_source):
                unknown.append({'kind': kind, 'value': value})
    return unknown
