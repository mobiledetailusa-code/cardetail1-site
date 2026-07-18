require('dotenv').config();
const { getPrisma } = require('../netlify/lib/prisma');

(async () => {
  const prisma = getPrisma();
  const row = await prisma.prismaHealth.create({ data: { label: 'cardetail1-smoke' } });
  const count = await prisma.prismaHealth.count();
  console.log(JSON.stringify({ ok: true, id: row.id, count }));
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
