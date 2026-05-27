/**
 * MongoDB replica set init — run inside mongo shell / docker for local transactions.
 */
try {
  rs.status();
} catch {
  rs.initiate({
    _id: "rs0",
    members: [{ _id: 0, host: "localhost:27017" }]
  });
}
