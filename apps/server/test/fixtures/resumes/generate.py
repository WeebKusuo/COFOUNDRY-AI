"""Regenerates the resume PDF fixtures used by the server tests.

Run with:  python3 generate.py   (needs reportlab and pypdf; output is committed)
All content is fictional demo data.
"""
from io import BytesIO
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter

def page_text(c, lines, y=800):
    for line in lines:
        c.drawString(60, y, line)
        y -= 18

def resume():
    c = canvas.Canvas('resume-text.pdf', pagesize=A4)
    c.setTitle('Demo resume')
    page_text(c, [
        'Riya Demo - Backend Developer',
        'Email: riya.demo@example.com  Phone: +91 98765 43210',
        'Portfolio: https://riya-demo.example.dev',
        'Experience',
        'Built a Node.js REST API for invoice reconciliation with MongoDB and Jest tests.',
        'Added JWT authentication and rate limiting to an Express service.',
        'Skills: Node.js, TypeScript, MongoDB, Docker, Git',
    ])
    c.showPage()
    c.save()

def image_only():
    # Vector shapes only: the PDF opens but has no extractable text (like a scan without OCR).
    c = canvas.Canvas('resume-no-text.pdf', pagesize=A4)
    c.rect(60, 600, 300, 150, fill=1)
    c.circle(300, 400, 80, fill=0)
    c.showPage()
    c.save()

def many_pages():
    c = canvas.Canvas('resume-12-pages.pdf', pagesize=A4)
    for i in range(1, 13):
        page_text(c, [f'Page {i} of a long demo resume.', f'Section {i}: built and tested services.'])
        c.showPage()
    c.save()

def encrypted():
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    page_text(c, ['Password protected demo resume.'])
    c.showPage()
    c.save()
    reader = PdfReader(BytesIO(buf.getvalue()))
    writer = PdfWriter()
    for p in reader.pages:
        writer.add_page(p)
    writer.encrypt(user_password='secret-pass', owner_password='owner-pass', algorithm='AES-256')
    with open('resume-encrypted.pdf', 'wb') as f:
        writer.write(f)

def malformed():
    # Valid signature and trailer marker, but no parsable document structure.
    body = b'%PDF-1.7\n' + b'this is not a pdf object graph ' * 200 + b'\n%%EOF\n'
    with open('resume-malformed.pdf', 'wb') as f:
        f.write(body)

resume(); image_only(); many_pages(); encrypted(); malformed()
