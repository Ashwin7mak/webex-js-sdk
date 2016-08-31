/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 */

import lolex from 'lolex';
import {assert} from '@ciscospark/test-helper-chai';
import MockSpark from '@ciscospark/test-helper-mock-spark';
import sinon from '@ciscospark/test-helper-sinon';
import {Batcher} from '../../..';

function promiseTick(count) {
  let promise = Promise.resolve();
  while (count > 1) {
    promise = promise.then(() => {
      return promiseTick(1);
    });
    count -= 1;
  }
  return promise;
}

describe(`spark-core`, () => {
  describe(`Batcher`, () => {
    let spark;
    const MockBatcher = Batcher.extend({
      namespace: `mock`,
      submitHttpRequest(payload) {
        return spark.request({
          api: `mock`,
          resource: `/batch`,
          body: payload
        });
      },
      fingerprintRequest(req) {
        return Promise.resolve(req);
      },
      fingerprintResponse(res) {
        return Promise.resolve(res);
      }
    });

    const OutOfBandBatcher = MockBatcher.extend({
      handleHttpSuccess() {
        return Promise.resolve();
      },

      fingerprintRequest(req) {
        return Promise.resolve(req.id);
      },
      fingerprintResponse(res) {
        return Promise.resolve(res.id);
      }
    });

    const BATCHER_MAX_CALLS = 10;
    const BATCHER_MAX_WAIT = 5;
    const BATCHER_WAIT = 2;

    beforeEach(() => {
      spark = new MockSpark({
        children: {
          batcher: MockBatcher,
          outOfBandBatcher: OutOfBandBatcher
        }
      });

      spark.config.mock = {
        batcherMaxCalls: BATCHER_MAX_CALLS,
        batcherWait: BATCHER_WAIT,
        batcherMaxWait: BATCHER_MAX_WAIT
      };
    });

    let clock;
    beforeEach(() => {
      clock = lolex.install(Date.now());
    });

    afterEach(() => {
      clock.uninstall();
    });

    describe(`#request()`, () => {
      it(`coalesces requests made in a short time period into a single request`, () => {
        const promises = [];
        spark.request.returns(Promise.resolve({body: [0, 1, 2]}));

        promises.push(spark.batcher.request(0));
        assert.notCalled(spark.request);

        promises.push(spark.batcher.request(1));
        assert.notCalled(spark.request);

        promises.push(spark.batcher.request(2));
        assert.notCalled(spark.request);


        return promiseTick(50)
          .then(() => {
            clock.tick(1);
            assert.notCalled(spark.request);
            clock.tick(1);
            return promiseTick(50);
          })
          .then(() => {
            assert.calledOnce(spark.request);
            return assert.isFulfilled(Promise.all(promises));
          })
          .then((results) => {
            assert.lengthOf(results, 3);
            for (let i = 0; i < 3; i++) {
              assert.equal(results[i], i);
            }
            clock.tick(250);
            return promiseTick(50);
          })
          .then(() => {
            assert.calledOnce(spark.request);
          });
      });

      // I'm not quite sure how to prove this one yet
      it.skip(`propagates error from inside the call chain`, () => {
        // This is way easier to prove if we don't need to control the clock
        clock.uninstall();
        sinon.stub(spark.batcher, `fingerprintResponse`).throws(new Error(`simulated failure`));
        spark.request.returns(Promise.resolve({body: [{id: 1}]}));
        return assert.isRejected(spark.batcher.request({id: 1}), /blarg/);
      });

      describe(`when the number of request attempts exceeds a given threshold`, () => {
        it(`executes the batch request, regardless of the time passed`, () => {
          const result = [];
          spark.request.returns(Promise.resolve({body: result}));

          const promises = [];
          // eslint-disable-next-line no-unmodified-loop-condition
          for (let i = 0; i < BATCHER_MAX_CALLS + 1; i++) {
            result.push(i);
            promises.push(spark.batcher.request(i));
            assert.notCalled(spark.request);
          }

          return promiseTick(50)
            .then(() => {
              assert.calledOnce(spark.request);
              return assert.isFulfilled(Promise.all(promises));
            })
            .then((results) => {
              assert.lengthOf(results, BATCHER_MAX_CALLS + 1);
              // eslint-disable-next-line no-unmodified-loop-condition
              for (let i = 0; i < BATCHER_MAX_CALLS + 1; i++) {
                assert.equal(results[i], i);
              }
              clock.tick(250);
              return promiseTick(50);
            })
            .then(() => {
              assert.calledOnce(spark.request);
            });
        });
      });

      describe(`when the requests are requestd continuously`, () => {
        describe(`when a configured time period is exceeded`, () => {
          it(`executes the batch request`, () => {
            const promises = [];
            const result = [];
            // eslint-disable-next-line no-unmodified-loop-condition
            for (let i = 0; i < BATCHER_MAX_WAIT + 1; i++) {
              result.push(i);
            }
            spark.request.returns(Promise.resolve({body: result}));
            spark.request.onCall(1).returns(Promise.resolve({body: []}));

            return result.reduce((promise, i) => promise.then(() => {
              promises.push(spark.batcher.request(i));
              clock.tick(1);
              return promiseTick(50);
            }), Promise.resolve())
              .then(() => {
                assert.calledOnce(spark.request);
                return Promise.all(promises);
              })
              .then((results) => {
                assert.lengthOf(results, BATCHER_MAX_WAIT + 1);

                // eslint-disable-next-line no-unmodified-loop-condition
                for (let i = 0; i < BATCHER_MAX_WAIT + 1; i++) {
                  assert.equal(results[i], i);
                }
                clock.tick(250);
                return promiseTick(50);
              })
              .then(() => {
                // This assertion is different than the other tests because
                // we've requestd enough requests that the normal debounce will
                // take over
                assert.calledTwice(spark.request);
              });
          });
        });
      });

      describe(`when it's overridden to handle out-of-band responses`, () => {
        it(`resolves as expected`, () => {
          sinon.spy(spark.outOfBandBatcher, `fingerprintResponse`);
          const promise = spark.outOfBandBatcher.request({id: 1});
          return promiseTick(50)
            .then(() => clock.tick(2))
            .then(() => {
              assert.called(spark.request);
              assert.notCalled(spark.outOfBandBatcher.fingerprintResponse);
              spark.outOfBandBatcher.acceptItem({id: 1, data: 2});
              return promiseTick(50);
            })
            .then(() => assert.isFulfilled(promise))
            .then((res) => {
              assert.deepEqual(res, {
                id: 1,
                data: 2
              });
            });
        });
      });
    });
  });
});
