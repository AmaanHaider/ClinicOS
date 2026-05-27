/**
 * Database seed — demo clinics (India/London), doctors, templates, exceptions,
 * confirmed appointments, waitlist entries. npm run seed
 */
import { pathToFileURL } from "url";
import { DateTime } from "luxon";
import { connectDb, disconnectDb } from "../src/config/db.js";
import {
  Appointment,
  AppointmentEvent,
  AppointmentType,
  AvailabilityException,
  AvailabilityTemplate,
  Clinic,
  Doctor,
  SlotOffer,
  SlotReservation,
  WaitlistEntry
} from "../src/models/index.js";
import { writeEvent } from "../src/services/event.service.js";
import { getSlots } from "../src/services/slot.service.js";

const WEEKLY_TEMPLATE = {
  MON: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  TUE: [{ start: "10:00", end: "17:00" }],
  WED: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  THU: [{ start: "10:00", end: "17:00" }],
  FRI: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  SAT: [],
  SUN: []
};

const systemActor = { id: "seed", role: "system", name: "Seed" };

async function clearDatabase() {
  await Promise.all([
    AppointmentEvent.deleteMany({}),
    SlotOffer.deleteMany({}),
    WaitlistEntry.deleteMany({}),
    SlotReservation.deleteMany({}),
    Appointment.deleteMany({}),
    AvailabilityException.deleteMany({}),
    AvailabilityTemplate.deleteMany({}),
    Doctor.deleteMany({}),
    AppointmentType.deleteMany({}),
    Clinic.deleteMany({})
  ]);
}

async function createConfirmedAppointment({ clinicId, clinicTimezone, doctorId, type, slot, patientId, patient }) {
  const start = DateTime.fromISO(slot.start, { zone: "utc" });
  const end = DateTime.fromISO(slot.end, { zone: "utc" });
  const [reservation] = await SlotReservation.create([{
    clinicId,
    doctorId,
    appointmentTypeId: type._id,
    durationMinutes: type.durationMinutes,
    slotStart: start.toJSDate(),
    slotEnd: end.toJSDate(),
    slotStartLocal: start.setZone(clinicTimezone).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    status: "confirmed"
  }]);
  const [appointment] = await Appointment.create([{
    clinicId,
    doctorId,
    appointmentTypeId: type._id,
    appointmentTypeName: type.name,
    durationMinutes: type.durationMinutes,
    currentReservationId: reservation._id,
    currentSlotStart: start.toJSDate(),
    currentSlotEnd: end.toJSDate(),
    status: "confirmed",
    patientId,
    patient,
    idempotencyKey: `seed-${clinicId}-${doctorId}-${start.toISO()}`
  }]);
  reservation.appointmentId = appointment._id;
  await reservation.save();
  await writeEvent({
    appointment,
    eventType: "created",
    actor: systemActor,
    previousState: null,
    newState: "confirmed"
  });
  return appointment;
}

export async function runSeed() {
  await clearDatabase();

  const clinics = await Clinic.create([
    { _id: "clinic_india", name: "Sharma Medical Centre", timezone: "Asia/Kolkata", contactEmail: "admin@sharma.example", isActive: true },
    { _id: "clinic_london", name: "London Family Practice", timezone: "Europe/London", contactEmail: "admin@london.example", isActive: true }
  ]);

  const doctorsByClinic = {};

  for (const clinic of clinics) {
    const types = await AppointmentType.create([
      { clinicId: clinic._id, name: "General Consult", durationMinutes: 15, color: "#4A90E2", isActive: true },
      { clinicId: clinic._id, name: "Follow-up", durationMinutes: 10, color: "#7ED321", isActive: true },
      { clinicId: clinic._id, name: "Procedure", durationMinutes: 30, color: "#D0021B", isActive: true }
    ]);
    doctorsByClinic[clinic._id] = [];

    for (let i = 1; i <= 3; i += 1) {
      const doctor = await Doctor.create({
        clinicId: clinic._id,
        name: `Dr. ${clinic._id === "clinic_india" ? "Sharma" : "Smith"} ${i}`,
        specialisation: "General Physician",
        email: `doctor${i}@${clinic._id}.example`,
        supportedAppointmentTypes: types.map((t) => t._id),
        isActive: true
      });
      doctorsByClinic[clinic._id].push(doctor);

      await AvailabilityTemplate.create({
        clinicId: clinic._id,
        doctorId: doctor._id,
        weeklyTemplate: WEEKLY_TEMPLATE,
        isActive: true
      });

      const tomorrow = DateTime.now().setZone(clinic.timezone).plus({ days: 1 }).toISODate();
      const dayAfter = DateTime.now().setZone(clinic.timezone).plus({ days: 2 }).toISODate();
      await AvailabilityException.create([
        { clinicId: clinic._id, doctorId: doctor._id, date: tomorrow, type: "block", windows: [], reason: "Conference" },
        { clinicId: clinic._id, doctorId: doctor._id, date: dayAfter, type: "override", windows: [{ start: "10:00", end: "14:00" }], reason: "Half day" }
      ]);
    }
  }

  const appointmentPlans = [];
  outer: for (const clinic of clinics) {
    const consult = await AppointmentType.findOne({ clinicId: clinic._id, name: "General Consult" });
    const from = DateTime.now().setZone(clinic.timezone).plus({ days: 3 }).toISODate();
    const to = DateTime.now().setZone(clinic.timezone).plus({ days: 33 }).toISODate();

    for (const doctor of doctorsByClinic[clinic._id]) {
      const { slots } = await getSlots(clinic._id, {
        doctorId: doctor._id,
        appointmentType: consult._id,
        from,
        to
      });
      for (const slot of slots) {
        if (appointmentPlans.length >= 10) break outer;
        appointmentPlans.push({
          clinicId: clinic._id,
          clinicTimezone: clinic.timezone,
          doctorId: doctor._id,
          type: consult,
          slot
        });
      }
    }
  }

  const appointments = [];
  for (let i = 0; i < appointmentPlans.length; i += 1) {
    const plan = appointmentPlans[i];
    appointments.push(await createConfirmedAppointment({
      ...plan,
      patientId: `patient_seed_${i + 1}`,
      patient: { name: `Seed Patient ${i + 1}` }
    }));
  }

  const indiaDoctor = doctorsByClinic.clinic_india[0];
  const indiaConsult = await AppointmentType.findOne({ clinicId: "clinic_india", name: "General Consult" });
  const londonDoctor = doctorsByClinic.clinic_london[0];
  const londonConsult = await AppointmentType.findOne({ clinicId: "clinic_london", name: "General Consult" });
  const indiaFrom = DateTime.now().setZone("Asia/Kolkata").plus({ days: 5 }).toISODate();
  const londonFrom = DateTime.now().setZone("Europe/London").plus({ days: 5 }).toISODate();

  await WaitlistEntry.create([
    {
      clinicId: "clinic_india",
      doctorId: indiaDoctor._id,
      appointmentTypeId: indiaConsult._id,
      targetDate: indiaFrom,
      patientId: "patient_wait_india",
      patient: { name: "Sunita Rao" },
      urgencyFlag: true,
      status: "waiting",
      joinedAt: new Date()
    },
    {
      clinicId: "clinic_london",
      doctorId: londonDoctor._id,
      appointmentTypeId: londonConsult._id,
      targetDate: londonFrom,
      patientId: "patient_wait_london",
      patient: { name: "James Wright" },
      urgencyFlag: false,
      status: "waiting",
      joinedAt: new Date()
    }
  ]);

  const clinicIds = clinics.map((c) => c._id);
  return {
    clinics: clinics.length,
    doctors: await Doctor.countDocuments({ clinicId: { $in: clinicIds } }),
    appointmentTypes: await AppointmentType.countDocuments({ clinicId: { $in: clinicIds } }),
    templates: await AvailabilityTemplate.countDocuments({ clinicId: { $in: clinicIds } }),
    exceptions: await AvailabilityException.countDocuments({ clinicId: { $in: clinicIds } }),
    appointments: appointments.length,
    reservations: await SlotReservation.countDocuments({ clinicId: { $in: clinicIds }, status: "confirmed" }),
    waitlistEntries: await WaitlistEntry.countDocuments({ clinicId: { $in: clinicIds } })
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await connectDb();
  const summary = await runSeed();
  console.log("Seed complete", summary);
  await disconnectDb();
}
