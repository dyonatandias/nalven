"use client";
import { createContext, useContext } from "react";
export const PlanFeatures = createContext({ services: true, marketplaces: true });
export const usePlanFeatures = () => useContext(PlanFeatures);
