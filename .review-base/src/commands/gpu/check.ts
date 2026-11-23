import { Flags } from '@oclif/core'
import { OcboxCommand } from '../../cli/base-command.js'
import { checkGpu, renderGpuCheck } from '../../hosted/gpu.js'
import { createMetadataClient } from '../../metadata/client.js'
import { hostedFlags } from '../../metadata/command.js'

/** Read-only GPU check; reserves nothing and uses protected login credentials. */
export default class GpuCheck extends OcboxCommand {
  static override description =
    'Check whether a GPU box can be created right now, without creating anything'
  static override flags = {
    ...hostedFlags,
    'gpu-type': Flags.string({
      required: true,
      description: 'GPU type id from `ocbox sizes`',
    }),
    'gpu-count': Flags.integer({
      required: true,
      min: 1,
      max: 64,
      description: 'Number of GPUs in one box',
    }),
    'lifetime-seconds': Flags.integer({
      min: 1,
      max: 86_400,
      description: 'Requested box lifetime in seconds',
    }),
    cpu: Flags.integer({ min: 1, max: 64, description: 'Requested vCPU cores' }),
    'memory-mib': Flags.integer({ min: 1, max: 262_144, description: 'Requested memory in MiB' }),
    'disk-gib': Flags.integer({ min: 1, max: 1024, description: 'Requested disk in GiB' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(GpuCheck)
    const interrupt = this.abortOnInterrupt()
    try {
      await this.emitResult(flags, 'gpu.checked', renderGpuCheck, () =>
        checkGpu(
          createMetadataClient(flags),
          {
            gpuType: flags['gpu-type'],
            gpuCount: flags['gpu-count'],
            ...(flags['lifetime-seconds'] === undefined
              ? {}
              : { lifetimeSeconds: flags['lifetime-seconds'] }),
            ...(flags.cpu === undefined ? {} : { cpu: flags.cpu }),
            ...(flags['memory-mib'] === undefined ? {} : { memoryMib: flags['memory-mib'] }),
            ...(flags['disk-gib'] === undefined ? {} : { diskGib: flags['disk-gib'] }),
          },
          interrupt.signal,
        ),
      )
    } finally {
      interrupt.dispose()
    }
  }
}
