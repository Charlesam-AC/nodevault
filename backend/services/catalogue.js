const { catalogueRows, listBookClasses } = require('./layout');

async function syncCatalogue(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM denomination_catalogue');
    const rows = listBookClasses().flatMap((bookClass) => catalogueRows(bookClass));
    for (const row of rows) {
      await client.query(
        `INSERT INTO denomination_catalogue (
           book_class, page_side, group_code, group_label, channel_code,
           denomination_code, header_label, sort_order, currency_code, symbol,
           cell_kind, in_grand
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          row.book_class,
          row.page_side,
          row.group_code,
          row.group_label,
          row.channel_code,
          row.denomination_code,
          row.header_label,
          row.sort_order,
          row.currency_code,
          row.symbol,
          row.cell_kind,
          row.in_grand,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { syncCatalogue };
