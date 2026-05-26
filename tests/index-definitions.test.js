import { describe, expect, it } from "vitest";
import { Appointment } from "../src/models/Appointment.js";
import { AppointmentEvent } from "../src/models/AppointmentEvent.js";
import { AvailabilityException } from "../src/models/AvailabilityException.js";
import { AvailabilityTemplate } from "../src/models/AvailabilityTemplate.js";
import { SlotOffer } from "../src/models/SlotOffer.js";
import { SlotReservation } from "../src/models/SlotReservation.js";
import { WaitlistEntry } from "../src/models/WaitlistEntry.js";

function indexes(model) {
  return model.schema.indexes();
}

describe("schema indexes", () => {
  it("defines tenant-scoped active reservation unique index", () => {
    const found = indexes(SlotReservation).find(([keys, opts]) =>
      keys.clinicId === 1 && keys.doctorId === 1 && keys.slotStart === 1 && opts.unique
    );
    expect(found?.[1].partialFilterExpression.status.$in).toEqual(["held", "confirmed"]);
  });

  it("defines unique exception per doctor date", () => {
    const found = indexes(AvailabilityException).find(([keys, opts]) =>
      keys.clinicId === 1 && keys.doctorId === 1 && keys.date === 1 && opts.unique
    );
    expect(found).toBeTruthy();
  });

  it("defines one active slot offer per opened slot", () => {
    const found = indexes(SlotOffer).find(([keys, opts]) =>
      keys.clinicId === 1 && keys.doctorId === 1 && keys.appointmentTypeId === 1 && keys.slotStart === 1 && opts.unique
    );
    expect(found?.[1].partialFilterExpression.status).toBe("offered");
  });

  it("defines appointment idempotency and list indexes", () => {
    const idempotency = indexes(Appointment).find(([keys, opts]) => keys.idempotencyKey === 1 && opts.unique);
    expect(idempotency?.[1].sparse).toBe(true);
    expect(indexes(Appointment).some(([keys]) => keys.clinicId === 1 && keys.doctorId === 1)).toBe(true);
  });

  it("defines waitlist queue and duplicate patient indexes", () => {
    expect(indexes(WaitlistEntry).some(([keys]) => keys.urgencyFlag === -1 && keys.joinedAt === 1)).toBe(true);
    expect(indexes(WaitlistEntry).some(([keys, opts]) => keys.patientId === 1 && opts.unique)).toBe(true);
  });

  it("defines appointment event history indexes", () => {
    expect(indexes(AppointmentEvent).some(([keys]) => keys.appointmentId === 1)).toBe(true);
    expect(indexes(AppointmentEvent).some(([keys]) => keys.clinicId === 1)).toBe(true);
  });

  it("defines active availability template index", () => {
    expect(indexes(AvailabilityTemplate).some(([keys, opts]) => keys.doctorId === 1 && opts.unique)).toBe(true);
  });
});

