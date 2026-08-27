import { Service } from '@karaka/cordis'

export class GreeterService extends Service {
  constructor(ctx, greet) {
    super(ctx, 'greeter')
    this.greet = greet
  }
}
