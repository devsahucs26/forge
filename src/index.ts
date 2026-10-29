#!/usr/bin/env node
import { Command } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";

const program = new Command();

program
  .name("forge")
  .description("Forge CLI")
  .version("1.0.0");

program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(runCommand);

program.parse();
