#!/usr/bin/env node
import { Command } from "commander";

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

program
  .command("doctor")
  .description("Perform diagnostic checks on your environment")
  .action(() => {
    console.log("Forge: running doctor diagnostics...");
  });

program.parse();
