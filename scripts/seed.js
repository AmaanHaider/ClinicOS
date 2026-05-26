import { DateTime } from "luxon";
import { connectDb, disconnectDb } from "../src/config/db.js";
import { Appointment, AppointmentType, AvailabilityException, AvailabilityTemplate, Clinic, Doctor, SlotReservation, WaitlistEntry } from "../src/models/index.js";
import { writeEvent } from "../src/services/event.service.js";

await connectDb();
await Promise.all([
  Clinic.deleteMany({}),
  Doctor.deleteMany({}),
  AppointmentType.deleteMany({}),
  AvailabilityTemplate.deleteMany({}),
  AvailabilityException.deleteMany({}),
  Appointment.deleteMany({}),
  SlotReservation.deleteMany({}),
  WaitlistEntry.deleteMany({})
]);

const clinics = await Clinic.create([
  { _id: "clinic_india", name: "Sharma Medical Centre", timezone: "Asia/Kolkata", contactEmail: "admin@sharma.example", isActive: true },
  { _id: "clinic_london", name: "London Family Practice", timezone: "Europe/London", contactEmail: "admin@london.example", isActive: true }
]);

const template = {
  MON: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  TUE: [{ start: "10:00", end: "17:00" }],
  WED: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  THU: [{ start: "10:00", end: "17:00" }],
  FRI: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "18:00" }],
  SAT: [],
  SUN: []
};

for (const clinic of clinics) {
  const types = await AppointmentType.create([
    { clinicId: clinic._id, name: "General Consult", durationMinutes: 15, color: "#4A90E2", isActive: true },
    { clinicId: clinic._id, name: "Follow-up", durationMinutes: 10, color: "#7ED321", isActive: true },
    { clinicId: clinic._id, name: "Procedure", durationMinutes: 30, color: "#D0021B", isActive: true }
  ]);
  for (let i = 1; i <= 3; i += 1) {
    const doctor = await Doctor.create({
      clinicId: clinic._id,
      name: `Dr. ${clinic._id === "clinic_india" ? "Sharma" : "Smith"} ${i}`,
      specialisation: "General Physician",
      email: `doctor${i}@${clinic._id}.example`,
      supportedAppointmentTypes: types.map((t) => t._id),
      isActive: true
    });
    await AvailabilityTemplate.create({ clinicId: clinic._id, doctorId: doctor._id, weeklyTemplate: template, isActive: true });
    const tomorrow = DateTime.now().setZone(clinic.timezone).plus({ days: 1 }).toISODate();
    const dayAfter = DateTime.now().setZone(clinic.timezone).plus({ days: 2 }).toISODate();
    await AvailabilityException.create([
      { clinicId: clinic._id, doctorId: doctor._id, date: tomorrow, type: "block", windows: [], reason: "Conference" },
      { clinicId: clinic._id, doctorId: doctor._id, date: dayAfter, type: "override", windows: [{ start: "10:00", end: "14:00" }], reason: "Half day" }
    ]);
  }
}

const doctor = await Doctor.findOne({ clinicId: "clinic_india" });
const type = await AppointmentType.findOne({ clinicId: "clinic_india", name: "General Consult" });
const start = DateTime.now().setZone("Asia/Kolkata").plus({ days: 3 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toUTC();
const end = start.plus({ minutes: type.durationMinutes });
const reservation = await SlotReservation.create({
  clinicId: "clinic_india",
  doctorId: doctor._id,
  appointmentTypeId: type._id,
  durationMinutes: type.durationMinutes,
  slotStart: start.toJSDate(),
  slotEnd: end.toJSDate(),
  slotStartLocal: start.setZone("Asia/Kolkata").toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  status: "confirmed"
});
const appointment = await Appointment.create({
  clinicId: "clinic_india",
  doctorId: doctor._id,
  appointmentTypeId: type._id,
  appointmentTypeName: type.name,
  durationMinutes: type.durationMinutes,
  currentReservationId: reservation._id,
  currentSlotStart: start.toJSDate(),
  currentSlotEnd: end.toJSDate(),
  status: "confirmed",
  patientId: "patient_seed",
  patient: { name: "Rahul Verma", phone: "+91-98765-43210" }
});
reservation.appointmentId = appointment._id;
await reservation.save();
await writeEvent({ appointment, eventType: "created", actor: { id: "seed", role: "system", name: "Seed" }, previousState: null, newState: "confirmed" });
await WaitlistEntry.create({ clinicId: "clinic_india", doctorId: doctor._id, appointmentTypeId: type._id, targetDate: start.toISODate(), patientId: "patient_wait", patient: { name: "Sunita Rao" }, urgencyFlag: true });

console.log("Seed complete");
await disconnectDb();

