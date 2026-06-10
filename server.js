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
const doc = new PDFDocument({ margin: 50 });
res.setHeader('Content-Type', 'application/pdf');
doc.pipe(res);
doc.fontSize(20).text((inv.tenant.brandName || inv.tenant.name) + ' - Invoice ' + inv.number);
doc.moveDown().fontSize(11);
doc.text('From: ' + inv.tenant.name);
if (inv.tenant.address) doc.text(inv.tenant.address);
if (inv.tenant.vatNumber) doc.text('VAT: ' + inv.tenant.vatNumber);
doc.moveDown();
const billTo = inv.customer || inv.contractor;
if (billTo) {
doc.text('Bill to: ' + billTo.name);
if (billTo.address) doc.text(billTo.address);
if (inv.contractor && inv.contractor.utr) doc.text('UTR: ' + inv.contractor.utr);
}
doc.moveDown();
inv.items.forEach(i => doc.text(i.description + ' - ' + i.qty + ' x GBP' + i.unitPrice.toFixed(2) + ' = GBP' + (i.qty * i.unitPrice).toFixed(2)));
doc.moveDown();
doc.text('Subtotal: GBP' + t.gross.toFixed(2));
if (inv.vatRate) doc.text('VAT (' + inv.vatRate + '%): GBP' + t.vat.toFixed(2));
if (inv.type === 'cis') doc.text('CIS deduction (' + inv.cisRate + '%): -GBP' + t.cis.toFixed(2));
doc.fontSize(14).text('Total payable: GBP' + t.net.toFixed(2));
doc.end();
});
app.post('/api/invoices/:id/send', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true, contractor: true, customer: true, tenant: true } });
if (!inv) return res.status(404).end();
const t = totals(inv);
const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
const lines = ['Invoice ' + inv.number, 'Subtotal GBP' + t.gross.toFixed(2)];
if (inv.vatRate) lines.push('VAT GBP' + t.vat.toFixed(2));
if (inv.type === 'cis') lines.push('CIS -GBP' + t.cis.toFixed(2));
lines.push('Total GBP' + t.net.toFixed(2));
await transporter.sendMail({ from: process.env.SMTP_USER, to: req.body.to, subject: 'Invoice ' + inv.number + ' from ' + (inv.tenant.brandName || inv.tenant.name), text: lines.join('\n') });
await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } });
res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Invoice Ready on ' + PORT));
