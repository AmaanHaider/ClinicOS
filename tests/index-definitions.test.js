import { describe, expect, it } from "vitest";
import { SlotReservation } from "../src/models/SlotReservation.js";
import { SlotOffer } from "../src/models/SlotOffer.js";
import { AvailabilityException } from "../src/models/AvailabilityException.js";

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
});

