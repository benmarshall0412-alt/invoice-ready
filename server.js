require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
function auth(req, res, next) {
const h = req.headers.authorization || '';
const t = h.startsWith('Bearer ') ? h.slice(7) : null;
if (!t) return res.status(401).json({ error: 'No token' });
try { req.user = jwt.verify(t, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Bad token' }); }
}
function totals(inv) {
const gross = inv.items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
const isCis = inv.type === 'cis';
const cis = isCis ? gross * (inv.cisRate / 100) : 0;
const vat = gross * ((inv.vatRate || 0) / 100);
return { gross, cis, vat, net: gross + vat - cis };
}
function money(n) { return 'GBP ' + n.toFixed(2); }
app.post('/api/register', async (req, res) => {
const { company, address, email, password } = req.body;
const exists = await prisma.user.findUnique({ where: { email } });
if (exists) return res.status(400).json({ error: 'Email in use' });
const tenant = await prisma.tenant.create({ data: { name: company, address, brandName: company } });
const user = await prisma.user.create({ data: { email, password: await bcrypt.hash(password, 10), role: 'owner', tenantId: tenant.id } });
const token = jwt.sign({ id: user.id, tenantId: tenant.id, role: user.role }, JWT_SECRET);
res.json({ token });
});
app.post('/api/login', async (req, res) => {
const { email, password } = req.body;
const user = await prisma.user.findUnique({ where: { email } });
if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials' });
const token = jwt.sign({ id: user.id, tenantId: user.tenantId, role: user.role }, JWT_SECRET);
res.json({ token });
});
app.get('/api/contractors', auth, async (req, res) => res.json(await prisma.contractor.findMany({ where: { tenantId: req.user.tenantId } })));
app.post('/api/contractors', auth, async (req, res) => {
const { name, address, email, utr } = req.body;
res.json(await prisma.contractor.create({ data: { name, address, email, utr, tenantId: req.user.tenantId } }));
});
app.get('/api/customers', auth, async (req, res) => res.json(await prisma.customer.findMany({ where: { tenantId: req.user.tenantId } })));
app.post('/api/customers', auth, async (req, res) => {
const { name, address, email, vatNumber } = req.body;
res.json(await prisma.customer.create({ data: { name, address, email, vatNumber, tenantId: req.user.tenantId } }));
});
app.put('/api/customers/:id', auth, async (req, res) => {
const { name, address, email, vatNumber } = req.body;
const c = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
if (!c) return res.status(404).json({ error: 'Not found' });
res.json(await prisma.customer.update({ where: { id: req.params.id }, data: { name, address, email, vatNumber } }));
});
app.delete('/api/customers/:id', auth, async (req, res) => {
const c = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
if (!c) return res.status(404).json({ error: 'Not found' });
await prisma.customer.delete({ where: { id: req.params.id } });
res.json({ ok: true });
});
app.get('/api/invoices', auth, async (req, res) => res.json(await prisma.invoice.findMany({ where: { tenantId: req.user.tenantId }, include: { items: true, contractor: true, customer: true }, orderBy: { createdAt: 'desc' } })));
app.post('/api/invoices', auth, async (req, res) => {
const { number, type, contractorId, customerId, cisRate, vatRate, notes, dueDate, items } = req.body;
res.json(await prisma.invoice.create({ data: { number, type: type || 'standard', contractorId: contractorId || null, customerId: customerId || null, cisRate: Number(cisRate) || 0, vatRate: Number(vatRate) || 0, notes, dueDate: dueDate ? new Date(dueDate) : null, tenantId: req.user.tenantId, items: { create: (items || []).map(i => ({ description: i.description, qty: Number(i.qty), unitPrice: Number(i.unitPrice) })) } }, include: { items: true } }));
});
app.put('/api/invoices/:id', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
if (!inv) return res.status(404).json({ error: 'Not found' });
const { number, type, contractorId, customerId, cisRate, vatRate, notes, status, dueDate, items } = req.body;
await prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } });
res.json(await prisma.invoice.update({ where: { id: req.params.id }, data: { number, type, contractorId: contractorId || null, customerId: customerId || null, cisRate: Number(cisRate) || 0, vatRate: Number(vatRate) || 0, notes, status, dueDate: dueDate ? new Date(dueDate) : null, items: { create: (items || []).map(i => ({ description: i.description, qty: Number(i.qty), unitPrice: Number(i.unitPrice) })) } }, include: { items: true } }));
});
app.delete('/api/invoices/:id', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
if (!inv) return res.status(404).json({ error: 'Not found' });
await prisma.invoice.delete({ where: { id: req.params.id } });
res.json({ ok: true });
});
app.get('/api/invoices/:id/pdf', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true, contractor: true, customer: true, tenant: true } });
if (!inv) return res.status(404).end();
const t = totals(inv);
const doc = new PDFDocument({ size: 'A4', margin: 50 });
res.setHeader('Content-Type', 'application/pdf');
doc.pipe(res);
const pageW = doc.page.width;
const left = 50;
const right = pageW - 50;
const brand = inv.tenant.brandName || inv.tenant.name;
const accent = '#1f6feb';
const grey = '#57606a';
const lightLine = '#d0d7de';
// Header band
doc.rect(0, 0, pageW, 90).fill(accent);
doc.fill('#ffffff').font('Helvetica-Bold').fontSize(22).text(brand, left, 28);
doc.font('Helvetica').fontSize(22).fillColor('#ffffff').text('INVOICE', left, 28, { align: 'right', width: right - left });
doc.fillColor('#000000');
// Company + invoice meta
let y = 110;
doc.font('Helvetica').fontSize(9).fillColor(grey);
doc.text(inv.tenant.name, left, y);
if (inv.tenant.address) doc.text(inv.tenant.address, left, doc.y);
if (inv.tenant.vatNumber) doc.text('VAT: ' + inv.tenant.vatNumber, left, doc.y);
// Meta box right side
const metaX = 350;
doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
doc.text('Invoice no', metaX, y, { width: 90 });
doc.text('Date', metaX, y + 16, { width: 90 });
if (inv.dueDate) doc.text('Due date', metaX, y + 32, { width: 90 });
doc.font('Helvetica').fillColor(grey);
doc.text(inv.number, metaX + 95, y, { width: right - metaX - 95, align: 'right' });
doc.text(new Date(inv.createdAt).toLocaleDateString('en-GB'), metaX + 95, y + 16, { width: right - metaX - 95, align: 'right' });
if (inv.dueDate) doc.text(new Date(inv.dueDate).toLocaleDateString('en-GB'), metaX + 95, y + 32, { width: right - metaX - 95, align: 'right' });
// Bill to block
const billTo = inv.customer || inv.contractor;
y = 175;
doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(inv.type === 'cis' ? 'Subcontractor' : 'Bill to', left, y);
doc.font('Helvetica').fontSize(10).fillColor(grey);
if (billTo) {
doc.text(billTo.name, left, doc.y + 2);
if (billTo.address) doc.text(billTo.address, left, doc.y);
if (billTo.email) doc.text(billTo.email, left, doc.y);
if (inv.contractor && inv.contractor.utr) doc.text('UTR: ' + inv.contractor.utr, left, doc.y);
if (inv.customer && inv.customer.vatNumber) doc.text('VAT: ' + inv.customer.vatNumber, left, doc.y);
}
// Items table
let ty = 260;
const cDesc = left, cQty = 320, cPrice = 390, cAmt = 470;
doc.rect(left, ty, right - left, 22).fill('#f0f3f6');
doc.fill('#000000').font('Helvetica-Bold').fontSize(9);
doc.text('Description', cDesc + 6, ty + 7);
doc.text('Qty', cQty, ty + 7, { width: 50, align: 'right' });
doc.text('Unit price', cPrice, ty + 7, { width: 60, align: 'right' });
doc.text('Amount', cAmt, ty + 7, { width: right - cAmt - 6, align: 'right' });
ty += 22;
doc.font('Helvetica').fontSize(9).fillColor('#000000');
inv.items.forEach(i => {
const amt = i.qty * i.unitPrice;
doc.text(i.description || '-', cDesc + 6, ty + 6, { width: cQty - cDesc - 12 });
doc.text(String(i.qty), cQty, ty + 6, { width: 50, align: 'right' });
doc.text(money(i.unitPrice), cPrice, ty + 6, { width: 60, align: 'right' });
doc.text(money(amt), cAmt, ty + 6, { width: right - cAmt - 6, align: 'right' });
ty += 24;
doc.strokeColor(lightLine).lineWidth(0.5).moveTo(left, ty).lineTo(right, ty).stroke();
});
// Totals block
let sy = ty + 14;
const labelX = 360, valX = 470;
function totRow(label, val, bold) {
doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#000000');
doc.text(label, labelX, sy, { width: 100 });
doc.text(val, valX, sy, { width: right - valX, align: 'right' });
sy += bold ? 20 : 16;
}
totRow('Subtotal', money(t.gross));
if (inv.vatRate) totRow('VAT (' + inv.vatRate + '%)', money(t.vat));
if (inv.type === 'cis') totRow('CIS deduction (' + inv.cisRate + '%)', '-' + money(t.cis));
doc.strokeColor(lightLine).lineWidth(1).moveTo(labelX, sy).lineTo(right, sy).stroke();
sy += 8;
doc.rect(labelX, sy - 2, right - labelX, 24).fill(accent);
doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11);
doc.text('Total payable', labelX + 6, sy + 4, { width: 110 });
doc.text(money(t.net), valX, sy + 4, { width: right - valX - 6, align: 'right' });
doc.fillColor('#000000');
sy += 40;
// Notes
if (inv.notes) {
doc.font('Helvetica-Bold').fontSize(9).text('Notes', left, sy);
doc.font('Helvetica').fontSize(9).fillColor(grey).text(inv.notes, left, doc.y + 2, { width: right - left });
doc.fillColor('#000000');
}
// Footer
if (inv.type === 'cis') {
doc.font('Helvetica-Oblique').fontSize(8).fillColor(grey).text('CIS deduction shown is withheld and paid to HMRC under the Construction Industry Scheme.', left, 760, { width: right - left });
}
doc.font('Helvetica').fontSize(8).fillColor(grey).text(brand + ' - Thank you for your business', left, 775, { width: right - left, align: 'center' });
doc.end();
});
app.post('/api/invoices/:id/send', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true, contractor: true, customer: true, tenant: true } });
if (!inv) return res.status(404).end();
const t = totals(inv);
const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
const lines = ['Invoice ' + inv.number, 'Subtotal ' + money(t.gross)];
if (inv.vatRate) lines.push('VAT ' + money(t.vat));
if (inv.type === 'cis') lines.push('CIS -' + money(t.cis));
lines.push('Total ' + money(t.net));
await transporter.sendMail({ from: process.env.SMTP_USER, to: req.body.to, subject: 'Invoice ' + inv.number + ' from ' + (inv.tenant.brandName || inv.tenant.name), text: lines.join('\n') });
await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } });
res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Invoice Ready on ' + PORT));
