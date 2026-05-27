import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { tenant } from "../middleware/tenant.js";
import { validate } from "../middleware/validate.js";
import * as clinic from "../controllers/clinic.controller.js";
import * as authController from "../controllers/auth.controller.js";
import * as doctor from "../controllers/doctor.controller.js";
import * as type from "../controllers/appointment-type.controller.js";
import * as availability from "../controllers/availability.controller.js";
import * as slot from "../controllers/slot.controller.js";
import * as appointment from "../controllers/appointment.controller.js";
import * as waitlist from "../controllers/waitlist.controller.js";
import { createClinicSchema } from "../validators/clinic.validator.js";
import { loginSchema, signupSchema } from "../validators/auth.validator.js";
import { createDoctorSchema, listDoctorsSchema } from "../validators/doctor.validator.js";
import { createAppointmentTypeSchema, patchAppointmentTypeSchema } from "../validators/appointmentType.validator.js";
import { deleteExceptionSchema, exceptionSchema, putAvailabilitySchema, validateAvailabilitySchema } from "../validators/availability.validator.js";
import { slotQuerySchema } from "../validators/slot.validator.js";
import { appointmentIdSchema, cancelAppointmentSchema, confirmAppointmentSchema, createAppointmentSchema, listAppointmentsSchema, rescheduleAppointmentSchema } from "../validators/appointment.validator.js";
import { joinWaitlistSchema, waitlistIdSchema } from "../validators/waitlist.validator.js";

export const routes = Router();

routes.get("/health", (_req, res) => res.json({ ok: true }));
routes.post("/clinics", validate(createClinicSchema), clinic.createClinic);
routes.post("/auth/signup", validate(signupSchema), authController.signup);
routes.post("/auth/login", validate(loginSchema), authController.login);

routes.use(auth, tenant);

routes.post("/clinics/:clinicId/doctors", validate(createDoctorSchema), doctor.createDoctor);
routes.get("/clinics/:clinicId/doctors", validate(listDoctorsSchema), doctor.listDoctors);
routes.post("/clinics/:clinicId/appointment-types", validate(createAppointmentTypeSchema), type.createAppointmentType);
routes.get("/clinics/:clinicId/appointment-types", type.listAppointmentTypes);
routes.patch("/appointment-types/:id", validate(patchAppointmentTypeSchema), type.patchAppointmentType);

routes.put("/doctors/:id/availability", validate(putAvailabilitySchema), availability.putAvailability);
routes.get("/doctors/:id/availability", availability.getAvailability);
routes.post("/doctors/:id/exceptions", validate(exceptionSchema), availability.upsertException);
routes.delete("/doctors/:id/exceptions/:date", validate(deleteExceptionSchema), availability.deleteException);
routes.post("/doctors/:id/availability/validate", validate(validateAvailabilitySchema), availability.validateAvailability);

routes.get("/slots", validate(slotQuerySchema), slot.slots);

routes.post("/appointments", validate(createAppointmentSchema), appointment.createAppointment);
routes.patch("/appointments/:id/confirm", validate(confirmAppointmentSchema), appointment.confirmAppointment);
routes.patch("/appointments/:id", validate(rescheduleAppointmentSchema), appointment.rescheduleAppointment);
routes.delete("/appointments/:id", validate(cancelAppointmentSchema), appointment.cancelAppointment);
routes.patch("/appointments/:id/noshow", validate(appointmentIdSchema), appointment.noShow);
routes.patch("/appointments/:id/complete", validate(appointmentIdSchema), appointment.complete);
routes.get("/appointments/:id", validate(appointmentIdSchema), appointment.getAppointment);
routes.get("/appointments/:id/history", validate(appointmentIdSchema), appointment.appointmentHistory);
routes.get("/clinics/:clinicId/appointments", validate(listAppointmentsSchema), appointment.listAppointments);

routes.post("/waitlist", validate(joinWaitlistSchema), waitlist.joinWaitlist);
routes.post("/waitlist/:id/accept", validate(waitlistIdSchema), waitlist.acceptOffer);
routes.get("/doctors/:id/waitlist", waitlist.listWaitlist);
routes.delete("/waitlist/:id", validate(waitlistIdSchema), waitlist.removeWaitlist);

