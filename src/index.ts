#!/usr/bin/env node
import { Command } from "commander";
import { doctorCommand } from "./commands/doctor.js";
import { runCommand } from "./commands/run.js";

const program = new Command();

program
  .name("forge")
  .description("Forge CLI")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize a new Forge project")
  .action(() => {
    console.log("Forge: initializing project...");
  });

program.addCommand(doctorCommand);
program.addCommand(runCommand);

program.parse();
