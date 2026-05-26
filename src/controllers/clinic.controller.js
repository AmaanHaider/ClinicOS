import * as clinicService from "../services/clinic.service.js";

export async function createClinic(req, res, next) {
  try {
    res.status(201).json(await clinicService.createClinic(req.validated.body));
  } catch (err) { next(err); }
}

