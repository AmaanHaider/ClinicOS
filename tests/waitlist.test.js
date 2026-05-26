import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { setupTestDb, teardownTestDb } from "./helpers/db.js";
import {
  authHeaders,
  bookPendingAppointment,
  cleanupFixture,
  createBookingFixture,
  firstAvailableSlot
} from "./helpers/fixtures.js";
import { SlotOffer, WaitlistEntry } from "../src/models/index.js";
import { offerNextWaitlistPatient } from "../src/services/waitlist.service.js";
import { DateTime } from "luxon";

const app = createApp();

async function bookAndConfirm(fixture, slot, patientId) {
  const { res: bookRes } = await bookPendingAppointment(app, fixture, { slot, patientId });
  expect(bookRes.status).toBe(201);
  await request(app)
    .patch(`/appointments/${bookRes.body._id}/confirm`)
    .set(authHeaders(fixture.clinic._id));
  return bookRes.body;
}

describe.sequential("waitlist", { timeout: 120000 }, () => {
  let fixture;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(async () => {
    if (fixture?.clinic?._id) await cleanupFixture(fixture.clinic._id);
    fixture = null;
  });

  it("rejects waitlist join when slots are still available", async () => {
    fixture = await createBookingFixture();
    const res = await request(app)
      .post("/waitlist")
      .set(authHeaders(fixture.clinic._id, { actorId: "wait_patient" }))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        targetDate: fixture.monday,
        patientId: "wait_patient"
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/book directly/i);
  });

  it("allows join when no slots remain for the date", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    await bookAndConfirm(fixture, slot, "blocker");

    const res = await request(app)
      .post("/waitlist")
      .set(authHeaders(fixture.clinic._id, { actorId: "wait_patient" }))
      .send({
        doctorId: fixture.doctor._id,
        appointmentTypeId: fixture.consult._id,
        targetDate: fixture.monday,
        patientId: "wait_patient"
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("waiting");
  });

  it("rejects duplicate waitlist entry for same patient", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    await bookAndConfirm(fixture, slot, "blocker");

    const body = {
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "dup_patient"
    };
    const first = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id)).send(body);
    const second = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id)).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it("offers to urgent patient first when a slot opens", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const blocker = await bookAndConfirm(fixture, slot, "blocker");

    await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "patient_a" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "patient_a",
      urgencyFlag: false
    });
    const urgent = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "patient_b" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "patient_b",
      urgencyFlag: true
    });

    await request(app)
      .delete(`/appointments/${blocker._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const offered = await WaitlistEntry.findOne({ clinicId: fixture.clinic._id, status: "offered" });
    expect(offered.patientId).toBe("patient_b");
    expect(offered._id).toBe(urgent.body._id);

    const activeOffers = await SlotOffer.countDocuments({ clinicId: fixture.clinic._id, status: "offered" });
    expect(activeOffers).toBe(1);
  });

  it("accepts offer and creates confirmed appointment", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const blocker = await bookAndConfirm(fixture, slot, "blocker");

    const join = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "accept_patient" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "accept_patient"
    });

    await request(app)
      .delete(`/appointments/${blocker._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    const acceptRes = await request(app)
      .post(`/waitlist/${join.body._id}/accept`)
      .set(authHeaders(fixture.clinic._id, { actorId: "accept_patient" }));

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.status).toBe("confirmed");

    const entry = await WaitlistEntry.findById(join.body._id);
    expect(entry.status).toBe("accepted");
  });

  it("returns 410 for expired offer and advances queue", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const blocker = await bookAndConfirm(fixture, slot, "blocker");

    const first = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "patient_a" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "patient_a"
    });
    await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "patient_b" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "patient_b"
    });

    await request(app)
      .delete(`/appointments/${blocker._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    await SlotOffer.updateMany(
      { clinicId: fixture.clinic._id, status: "offered" },
      { $set: { offerExpiresAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() } }
    );

    const expired = await request(app)
      .post(`/waitlist/${first.body._id}/accept`)
      .set(authHeaders(fixture.clinic._id, { actorId: "patient_a" }));
    expect(expired.status).toBe(410);

    const nextOffered = await WaitlistEntry.findOne({ clinicId: fixture.clinic._id, status: "offered" });
    expect(nextOffered?.patientId).toBe("patient_b");
  });

  it("returns 409 when slot re-taken and supersedes offer", async () => {
    fixture = await createBookingFixture({ narrowWindow: true });
    const slot = await firstAvailableSlot(fixture.clinic._id, fixture.doctor._id, fixture.consult._id, fixture.monday);
    const blocker = await bookAndConfirm(fixture, slot, "blocker");

    const join = await request(app).post("/waitlist").set(authHeaders(fixture.clinic._id, { actorId: "wait_accept" })).send({
      doctorId: fixture.doctor._id,
      appointmentTypeId: fixture.consult._id,
      targetDate: fixture.monday,
      patientId: "wait_accept"
    });

    await request(app)
      .delete(`/appointments/${blocker._id}`)
      .set(authHeaders(fixture.clinic._id))
      .send({ cancelledBy: "patient" });

    await bookPendingAppointment(app, fixture, { slot, patientId: "snatcher" });

    const acceptRes = await request(app)
      .post(`/waitlist/${join.body._id}/accept`)
      .set(authHeaders(fixture.clinic._id, { actorId: "wait_accept" }));
    expect(acceptRes.status).toBe(409);

    const offer = await SlotOffer.findOne({ clinicId: fixture.clinic._id, waitlistEntryId: join.body._id });
    expect(offer.status).toBe("superseded");
  });
});
