import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quasarRouter from "./quasar";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quasarRouter);

export default router;
