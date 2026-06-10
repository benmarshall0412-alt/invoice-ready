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
const cis = gross * (inv.cisRate / 100);
return { gross, cis, net: gross - cis };
}
app.post('/api/register', async (req, res) => {
const { company, address, email, password } = req.body;
const exists = await prisma.user.findUnique({ where: { email } });
if (exists) return res.status(400).json({ error: 'Email in use' });
const tenant = await prisma.tenant.create({ data: { name: company, address } });
const user = await prisma.user.create({ data: { email, password: await bcrypt.hash(password, 10), tenantId: tenant.id } });
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
app.get('/api/invoices', auth, async (req, res) => res.json(await prisma.invoice.findMany({ where: { tenantId: req.user.tenantId }, include: { items: true, contractor: true }, orderBy: { createdAt: 'desc' } })));
app.post('/api/invoices', auth, async (req, res) => {
const { number, contractorId, cisRate, notes, items } = req.body;
res.json(await prisma.invoice.create({ data: { number, contractorId, cisRate: cisRate || 0, notes, tenantId: req.user.tenantId, items: { create: (items || []).map(i => ({ description: i.description, qty: Number(i.qty), unitPrice: Number(i.unitPrice) })) } }, include: { items: true } }));
});
app.put('/api/invoices/:id', auth, async (req, res) => {
const { number, cisRate, notes, status, items } = req.body;
await prisma.invoiceItem.deleteMany({ where: { invoiceId: req.params.id } });
res.json(await prisma.invoice.update({ where: { id: req.params.id }, data: { number, cisRate, notes, status, items: { create: (items || []).map(i => ({ description: i.description, qty: Number(i.qty), unitPrice: Number(i.unitPrice) })) } }, include: { items: true } }));
});
app.get('/api/invoices/:id/pdf', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true, contractor: true, tenant: true } });
if (!inv) return res.status(404).end();
const t = totals(inv);
const doc = new PDFDocument({ margin: 50 });
res.setHeader('Content-Type', 'application/pdf');
doc.pipe(res);
doc.fontSize(20).text('Invoice ' + inv.number);
doc.moveDown().fontSize(11);
doc.text('From: ' + inv.contractor.name);
if (inv.contractor.address) doc.text(inv.contractor.address);
if (inv.contractor.utr) doc.text('UTR: ' + inv.contractor.utr);
doc.moveDown().text('To: ' + inv.tenant.name);
if (inv.tenant.address) doc.text(inv.tenant.address);
doc.moveDown();
inv.items.forEach(i => doc.text(i.description + ' - ' + i.qty + ' x GBP' + i.unitPrice.toFixed(2) + ' = GBP' + (i.qty * i.unitPrice).toFixed(2)));
doc.moveDown();
doc.text('Gross: GBP' + t.gross.toFixed(2));
doc.text('CIS deduction (' + inv.cisRate + '%): -GBP' + t.cis.toFixed(2));
doc.fontSize(14).text('Net payable: GBP' + t.net.toFixed(2));
doc.end();
});
app.post('/api/invoices/:id/send', auth, async (req, res) => {
const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: { items: true, contractor: true, tenant: true } });
if (!inv) return res.status(404).end();
const t = totals(inv);
const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
await transporter.sendMail({ from: process.env.SMTP_USER, to: req.body.to, subject: 'Invoice ' + inv.number + ' from ' + inv.contractor.name, text: 'Invoice ' + inv.number + '\\nGross GBP' + t.gross.toFixed(2) + '\\nCIS -GBP' + t.cis.toFixed(2) + '\\nNet GBP' + t.net.toFixed(2) });
await prisma.invoice.update({ where: { id: inv.id }, data: { status: 'sent' } });
res.json({ ok: true });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Invoice Ready on ' + PORT));
